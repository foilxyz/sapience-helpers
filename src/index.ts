// src/index.ts
import { EventEmitter } from 'events';
import {
  createPublicClient,
  // http, // No longer needed directly here if always using WebSocket for primary transport
  webSocket,
  PublicClient,
  HttpTransport, // Still needed for PublicClient type union
  WebSocketTransport,
  Chain,
  Abi,
  parseAbiItem,
} from 'viem';
import {
  mainnet,
  arbitrum,
  optimism,
  polygon,
  base,
  bsc,
  goerli,
  sepolia,
} from 'viem/chains'; // Importing common chains
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { resolvePoolAddress, PoolResolverParams } from './utils/poolResolver';

export interface MarketListenerOpts extends PoolResolverParams {
  rpcUrl?: string;
}

export interface Order {
  price: number;
  size: bigint;
}

interface SwapEventArgs {
  sender: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

export interface SwapUpdateEvent {
  marketPrice: number | undefined;
  orderBook: Order[];
  rawSwapArgs?: SwapEventArgs; // Optional: include for consumers who need raw details
  poolAddress: string;
  chainId: number;
  marketId: string;
  timestamp: number; // Timestamp of when the event was processed by the listener
}

// For strong typing of emitted events
interface MarketListenerEvents {
  'swap': (data: SwapUpdateEvent) => void;
  'error': (error: Error) => void;
}

// Mapping chain IDs to viem chain objects
const supportedChains: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [polygon.id]: polygon,
  [base.id]: base,
  [bsc.id]: bsc,
  [goerli.id]: goerli,
  [sepolia.id]: sepolia,
  // Add other chains here if needed
};

// Minimal ERC20 ABI for fetching decimals
const erc20Abi = [
  parseAbiItem('function decimals() view returns (uint8)'),
  // We might also need symbol() if we want to display token symbols later
  // parseAbiItem('function symbol() view returns (string)'),
] as const;

export declare interface MarketListener {
  on<U extends keyof MarketListenerEvents>(event: U, listener: MarketListenerEvents[U]): this;
  emit<U extends keyof MarketListenerEvents>(event: U, ...args: Parameters<MarketListenerEvents[U]>): boolean;
}

export class MarketListener extends EventEmitter {
  private publicClient: PublicClient<
    HttpTransport | WebSocketTransport, // Transport type can be either for viem
    Chain
  >;
  private poolAddress: string | undefined;
  private unwatch?: () => void;

  private marketPrice: number | undefined;
  private orderBook: Order[] = [];

  private opts: MarketListenerOpts;
  private selectedChain: Chain;

  // Token details
  private token0Address: `0x${string}` | undefined;
  private token1Address: `0x${string}` | undefined;
  private token0Decimals: number | undefined;
  private token1Decimals: number | undefined;

  constructor(options: MarketListenerOpts) {
    super(); // Call EventEmitter constructor
    this.opts = options;

    this.selectedChain = supportedChains[this.opts.chainId];
    if (!this.selectedChain) {
      const err = new Error(
        `[MarketListener] Unsupported chainId: ${this.opts.chainId}. Supported chain IDs are: ${Object.keys(supportedChains).join(', ')}`
      );
      // Synchronous error in constructor, no need to emit, just throw
      throw err;
    }

    let transportWsUrl: string | undefined = undefined;
    let transportToUse;

    if (options.rpcUrl) {
      if (options.rpcUrl.startsWith('wss://')) {
        transportWsUrl = options.rpcUrl;
        console.log(`[MarketListener] Using provided WebSocket RPC URL: ${transportWsUrl} for chain ${this.selectedChain.name}`);
      } else if (options.rpcUrl.startsWith('http://') || options.rpcUrl.startsWith('https://')) {
        console.warn(
          `[MarketListener] Provided RPC URL "${options.rpcUrl}" is HTTP. ` +
          `This listener primarily uses WebSockets for event monitoring. ` +
          `Will attempt to use default public WebSocket for chain ${this.selectedChain.name}.`
        );
      } else {
        console.warn(
          `[MarketListener] Provided RPC URL "${options.rpcUrl}" is not recognized as wss:// or http(s)://. ` +
          `Will attempt to use default public WebSocket for chain ${this.selectedChain.name}.`
        );
      }
    } else {
      console.log(
        `[MarketListener] No RPC URL provided. Using default public WebSocket for chain ${this.selectedChain.name}.`
      );
    }
    
    transportToUse = webSocket(transportWsUrl, {
      // Viem's default WebSocket handles reconnections.
      // Custom retry logic could be added here if needed.
    });

    this.publicClient = createPublicClient({
      chain: this.selectedChain,
      transport: transportToUse,
    });
  }

  private async fetchTokenDetails(): Promise<void> {
    if (!this.poolAddress) {
      throw new Error('[MarketListener] Pool address is not set. Cannot fetch token details.');
    }
    try {
      console.log(`[MarketListener] Fetching token details for pool: ${this.poolAddress}`);
      const [token0Addr, token1Addr] = await Promise.all([
        this.publicClient.readContract({
          address: this.poolAddress as `0x${string}`,
          abi: IUniswapV3PoolABI,
          functionName: 'token0',
        }),
        this.publicClient.readContract({
          address: this.poolAddress as `0x${string}`,
          abi: IUniswapV3PoolABI,
          functionName: 'token1',
        }),
      ]);

      this.token0Address = token0Addr as `0x${string}`;
      this.token1Address = token1Addr as `0x${string}`;
      console.log(`[MarketListener] Token0: ${this.token0Address}, Token1: ${this.token1Address}`);

      const [token0Dec, token1Dec] = await Promise.all([
        this.publicClient.readContract({
          address: this.token0Address,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
        this.publicClient.readContract({
          address: this.token1Address,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
      ]);

      this.token0Decimals = Number(token0Dec);
      this.token1Decimals = Number(token1Dec);
      console.log(`[MarketListener] Token0 Decimals: ${this.token0Decimals}, Token1 Decimals: ${this.token1Decimals}`);

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[MarketListener] Failed to fetch token details:', err);
      // We might want to emit this error or handle it more gracefully if token details are critical for all operations
      throw new Error(`Failed to fetch token details for pool ${this.poolAddress}: ${err.message}`);
    }
  }

  public async start(): Promise<void> {
    if (this.unwatch) {
      console.warn('[MarketListener] Listener already started.');
      return;
    }

    try {
      this.poolAddress = await resolvePoolAddress(this.opts);
      console.log(`[MarketListener] Resolved pool address: ${this.poolAddress} for market ${this.opts.marketId} on chain ${this.selectedChain.name}`);
      
      // Fetch token details after poolAddress is resolved
      await this.fetchTokenDetails();

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[MarketListener] Failed to start listener (pool resolution or token details fetch):', err);
      this.emit('error', err); 
      throw err; 
    }

    console.log(
      `[MarketListener] Listening for Swap events on pool: ${this.poolAddress} (Market: ${this.opts.marketId}, Chain: ${this.selectedChain.name})`
    );

    this.unwatch = this.publicClient.watchContractEvent({
      address: this.poolAddress as `0x${string}`,
      abi: IUniswapV3PoolABI,
      eventName: 'Swap',
      onLogs: (logs: any[]) => {
        logs.forEach((log: any) => {
          if (log.args && this.token0Decimals !== undefined && this.token1Decimals !== undefined) {
            const swapArgs = log.args as SwapEventArgs;
            
            // Calculate market price (price of token0 in terms of token1)
            const priceBase = (Number(swapArgs.sqrtPriceX96) / (2 ** 96)) ** 2;
            this.marketPrice = priceBase * (10 ** (this.token0Decimals - this.token1Decimals));

            // Order book remains empty for now
            this.orderBook = [];

            const eventData: SwapUpdateEvent = {
              marketPrice: this.marketPrice,
              orderBook: [...this.orderBook], 
              rawSwapArgs: swapArgs, 
              poolAddress: this.poolAddress!,
              chainId: this.selectedChain.id,
              marketId: this.opts.marketId,
              timestamp: Date.now(),
            };
            this.emit('swap', eventData);

            console.log(
              `[MarketListener] Swap Emitted (Price: ${this.marketPrice.toFixed(6)}) on ${this.selectedChain.name} / ${this.opts.marketId}:
                Pool: ${this.poolAddress}, Token0Dec: ${this.token0Decimals}, Token1Dec: ${this.token1Decimals}
                SqrtPriceX96: ${swapArgs.sqrtPriceX96}, Tick: ${swapArgs.tick}`
            );
          } else if (log.args) {
            console.warn('[MarketListener] Token decimals not yet available, skipping price calculation for swap.');
          }
        });
      },
      onError: (error: Error) => {
        console.error(`[MarketListener] Error watching contract events for ${this.opts.marketId} on ${this.selectedChain.name}:`, error);
        this.emit('error', error);
      },
    });
  }

  public stop(): void {
    if (this.unwatch) {
      console.log(`[MarketListener] Stopping event listener for ${this.opts.marketId} on ${this.selectedChain.name}...`);
      this.unwatch();
      this.unwatch = undefined;
    } else {
      console.warn('[MarketListener] Listener not started or already stopped.');
    }
  }

  public getMarketPrice(): number | undefined {
    return this.marketPrice;
  }

  public getOrderBook(): Order[] {
    return [...this.orderBook]; 
  }
}

// Example: How to use the MarketListener
async function main() {
  const listenerOpts: MarketListenerOpts = {
    chainId: 8453,
    marketAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    marketId: '1',
  };

  const listener = new MarketListener(listenerOpts);

  try {
    await listener.start();
    console.log(
      `[Example] MarketListener started for market ${listenerOpts.marketId} on chainId ${listenerOpts.chainId}. Listening for Swap events...`
    );

    // Example: Periodically get the latest market price and order book
    // In a real app, you might use these values to update a UI or trigger other logic.
    const intervalId = setInterval(() => {
      const price = listener.getMarketPrice();
      const book = listener.getOrderBook();
      console.log(
        `[Example] Current Market Price: ${price !== undefined ? price : 'N/A'}, Order Book Depth: ${book.length}`
      );
    }, 15000); // Log every 15 seconds

    // Graceful shutdown
    const shutdown = () => {
      console.log('[Example] Shutting down MarketListener...');
      clearInterval(intervalId);
      listener.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown); // CTRL+C
    process.on('SIGTERM', shutdown);

    // Keep the process running (useful for a standalone script)
    // In a larger application, this might not be necessary if other parts of the app keep it alive.
    // process.stdin.resume(); // Or a more robust server keep-alive mechanism

  } catch (error) {
    console.error('[Example] Failed to start MarketListener:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('[Example] Unhandled error in main function:', error);
  process.exit(1);
}); 