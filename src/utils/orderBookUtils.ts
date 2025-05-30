import type { PublicClient, Chain, HttpTransport, WebSocketTransport } from 'viem';
import { parseAbiItem } from 'viem';

const UNISWAP_V3_POOL_ABI_FOR_ORDERBOOK = [
  parseAbiItem('function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'),
  parseAbiItem('function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint256 secondsPerLiquidityOutsideX128, uint256 secondsOutside, bool initialized)'),
  parseAbiItem('function tickSpacing() view returns (int24)'),
] as const;

const Q96 = 2n ** 96n;
const Q192 = Q96 * Q96;

export interface OrderBookLevel {
  price: number;
  amountToken0: number;
}

export interface FetchOrderBookParams {
  publicClient: PublicClient<HttpTransport | WebSocketTransport, Chain>;
  poolAddress: `0x${string}`;
  token0Decimals: number;
  token1Decimals: number;
  ticksToQueryPerSide?: number;
}

export interface OrderBookReturn {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  currentMidTick: number;
  currentMidPrice: number;
}

function tickToSqrtPriceX96(tick: number): bigint {
  const priceRatio = Math.pow(1.0001, tick);
  return BigInt(Math.floor(Math.sqrt(priceRatio) * Number(Q96)));
}

export function tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
    const val = Math.pow(1.0001, tick);
    const priceOfToken0InToken1 = 1 / val;
    return priceOfToken0InToken1 * Math.pow(10, token0Decimals - token1Decimals);
}

// Define a type for the tuple returned by the ticks function ABI
type TickDataTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
// Define a type for the tuple returned by the slot0 function ABI
type Slot0DataTuple = readonly [bigint, number, number, number, number, number, boolean];

export async function fetchAndCalculateOrderBook(
  params: FetchOrderBookParams
): Promise<OrderBookReturn> {
  const { 
    publicClient, 
    poolAddress, 
    token0Decimals, 
    token1Decimals, 
    ticksToQueryPerSide = 50 
  } = params;

  const slot0Result = await publicClient.readContract({
    address: poolAddress,
    abi: UNISWAP_V3_POOL_ABI_FOR_ORDERBOOK,
    functionName: 'slot0',
  });
  const slot0Data = slot0Result as Slot0DataTuple;
  const currentTick = Number(slot0Data[1]); // tick is the second element
  let currentActiveLiquidity = slot0Data[0]; // sqrtPriceX96 is first, tick is second. Wait, slot0 ABI is (sqrtPriceX96, tick, ... liquidity is NOT in slot0)
                                            // Liquidity from slot0() is NOT the general pool liquidity. It's a misinterpretation.
                                            // The slot0.liquidity mentioned in some contexts usually refers to liquidity within the current tick range, but the function itself doesn't return L.
                                            // We need to sum liquidityNet from ticks to get active L. For the current range, it's more complex.
                                            // For now, let's assume currentActiveLiquidity needs to be established by summing from below. This is a simplification for now.
                                            // Fetching current pool liquidity directly: use pool.liquidity() if available in ABI, or calculate from ticks.
                                            // For this iteration, the placeholder logic for amounts will use a dummy L or one derived during iteration.
  // Let's fetch liquidity separately if it's part of the main ABI (it is in full IUniswapV3PoolABI)
  // For this util, we rely on passed-in data or build from ticks. The currentActiveLiquidity from slot0 is incorrect.
  // slot0().liquidity is not a return value. slot0 returns (sqrtPriceX96, tick, ...)
  // Let's get the global liquidity for the pool
  const poolLiquidity = await publicClient.readContract({
    address: poolAddress,
    abi: [parseAbiItem('function liquidity() view returns (uint128)')], // Add specific ABI for liquidity
    functionName: 'liquidity',
  });
  currentActiveLiquidity = poolLiquidity as bigint; // This is the L for the CURRENT active tick range.

  const tickSpacingResult = await publicClient.readContract({
    address: poolAddress,
    abi: UNISWAP_V3_POOL_ABI_FOR_ORDERBOOK,
    functionName: 'tickSpacing',
  });
  const tickSpacingNumber = Number(tickSpacingResult);

  const currentMidPrice = tickToPrice(currentTick, token0Decimals, token1Decimals);
  
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];

  const tickIndicesToQuery: number[] = [];
  for (let i = 0; i <= ticksToQueryPerSide; i++) {
    tickIndicesToQuery.push(currentTick - i * tickSpacingNumber);
  }
  for (let i = 1; i <= ticksToQueryPerSide; i++) {
    tickIndicesToQuery.push(currentTick + i * tickSpacingNumber);
  }
  const uniqueSortedTickIndices = [...new Set(tickIndicesToQuery)].sort((a, b) => a - b);

  const tickReadCalls = uniqueSortedTickIndices.map(tickIdx => ({
    address: poolAddress,
    abi: UNISWAP_V3_POOL_ABI_FOR_ORDERBOOK,
    functionName: 'ticks',
    args: [tickIdx],
  }));

  const tickResults = await publicClient.multicall({ contracts: tickReadCalls, allowFailure: true });

  const fetchedTicksData: Map<number, { liquidityNet: bigint, initialized: boolean }> = new Map();
  tickResults.forEach((result, i) => {
    if (result.status === 'success' && result.result) {
      // Cast to unknown first, then to the specific tuple type to override TS inference if it's too loose
      const tickTuple = result.result as unknown as TickDataTuple;
      // liquidityNet is the second element (index 1), initialized is the last (index 7)
      if (tickTuple[7]) { // Check initialized flag (index 7)
          fetchedTicksData.set(uniqueSortedTickIndices[i], { liquidityNet: tickTuple[1], initialized: tickTuple[7] });
      }
    }
  });

  // --- Calculate Asks (Placeholder amounts) ---
  let cumulativeL_asks = currentActiveLiquidity;
  for (let T = currentTick + tickSpacingNumber; T <= currentTick + ticksToQueryPerSide * tickSpacingNumber; T += tickSpacingNumber) {
    const price = tickToPrice(T, token0Decimals, token1Decimals);
    const tickDataForPrevSegment = fetchedTicksData.get(T - tickSpacingNumber);
    if(tickDataForPrevSegment) {
        cumulativeL_asks += tickDataForPrevSegment.liquidityNet;
    }
    // Placeholder: amount = L_active_in_this_segment * delta(1/sqrt(P))
    // The L here (cumulativeL_asks) is L active *up to* the start of this tick range (T)
    // The amount should be based on the liquidity *within* the range [T, T+tickSpacingNumber]
    // For a simple placeholder:
    const amountPlaceholder = Number(cumulativeL_asks / Q96) / (100 * Math.pow(10, token0Decimals)); // Highly simplified & scaled
    if (price > currentMidPrice) { // Ensure it's an ask
        asks.push({ price, amountToken0: amountPlaceholder });
    }
  }
  asks.sort((a,b) => a.price - b.price);

  // --- Calculate Bids (Placeholder amounts) ---
  let cumulativeL_bids = currentActiveLiquidity;
  for (let T = currentTick; T >= currentTick - ticksToQueryPerSide * tickSpacingNumber; T -= tickSpacingNumber) {
    // When moving down from currentTick for bids, liquidityNet at T is subtracted *after* processing range [T, T+ts)
    const price = tickToPrice(T, token0Decimals, token1Decimals);
    // Placeholder amount for range [T, T+tickSpacing)
    const amountPlaceholder = Number(cumulativeL_bids / Q96) / (100 * Math.pow(10, token0Decimals)); // Highly simplified & scaled
    if (price < currentMidPrice || T === currentTick) { // Ensure it's a bid or current tick level
         bids.push({ price, amountToken0: amountPlaceholder });
    }
    const tickData = fetchedTicksData.get(T);
    if (tickData) {
      cumulativeL_bids -= tickData.liquidityNet; 
    }
  }
  bids.sort((a,b) => b.price - a.price);

  return {
    bids,
    asks,
    currentMidTick: currentTick,
    currentMidPrice,
  };
} 