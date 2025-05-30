import { createPublicClient, http, isAddress, zeroAddress, Abi } from 'viem';

export interface PoolResolverParams {
  chainId: number;
  marketAddress: string;
  marketId: string;
  rpcUrl?: string;
}

const GQL_ENDPOINT = 'https://api.sapience.xyz/graphql';

interface MarketGql {
  id: string; // Corresponds to MarketType.id (GraphQL ID!)
  poolAddress: string | null;
}

interface MarketGroupGql {
  markets: MarketGql[] | null;
}

interface GraphQLApiResponse {
  data?: {
    marketGroup: MarketGroupGql | null;
  };
  errors?: Array<{ message: string; [key: string]: any }>;
}

// Minimal ABI for the getEpoch function from Foil.json
const foilContractAbi = [
  {
    "type": "function",
    "name": "getEpoch",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "epochData",
        "type": "tuple",
        "internalType": "struct IFoilStructs.EpochData",
        "components": [
          { "name": "epochId", "type": "uint256", "internalType": "uint256" },
          { "name": "startTime", "type": "uint256", "internalType": "uint256" },
          { "name": "endTime", "type": "uint256", "internalType": "uint256" },
          { "name": "pool", "type": "address", "internalType": "address" },
          { "name": "ethToken", "type": "address", "internalType": "address" },
          { "name": "gasToken", "type": "address", "internalType": "address" },
          { "name": "minPriceD18", "type": "uint256", "internalType": "uint256" },
          { "name": "maxPriceD18", "type": "uint256", "internalType": "uint256" },
          { "name": "baseAssetMinPriceTick", "type": "int24", "internalType": "int24" },
          { "name": "baseAssetMaxPriceTick", "type": "int24", "internalType": "int24" },
          { "name": "settled", "type": "bool", "internalType": "bool" },
          { "name": "settlementPriceD18", "type": "uint256", "internalType": "uint256" },
          { "name": "assertionId", "type": "bytes32", "internalType": "bytes32" },
          { "name": "claimStatement", "type": "bytes", "internalType": "bytes" }
        ]
      },
      {
        "name": "params",
        "type": "tuple",
        "internalType": "struct IFoilStructs.MarketParams",
        "components": [
            { "name": "feeRate", "type": "uint24", "internalType": "uint24" },
            { "name": "assertionLiveness", "type": "uint64", "internalType": "uint64" },
            { "name": "bondAmount", "type": "uint256", "internalType": "uint256" },
            { "name": "bondCurrency", "type": "address", "internalType": "address" },
            { "name": "uniswapPositionManager", "type": "address", "internalType": "address" },
            { "name": "uniswapSwapRouter", "type": "address", "internalType": "address" },
            { "name": "uniswapQuoter", "type": "address", "internalType": "address" },
            { "name": "optimisticOracleV3", "type": "address", "internalType": "address" }
        ]
      }
    ],
    "stateMutability": "view"
  }
] as const;

// TODO: Configure these RPC URLs properly for your environment and desired chains
const RPC_URLS: { [chainId: number]: string } = {
  1: 'https://eth.llamarpc.com', // Ethereum Mainnet
  42161: 'https://arbitrum.llamarpc.com', // Arbitrum One
  137: 'https://polygon.llamarpc.com', // Polygon
  10: 'https://optimism.llamarpc.com', // Optimism
  // Add other chains and their public or private RPC URLs as needed
};

/**
 * Resolves a pool address by querying the Foil smart contract on-chain.
 * It fetches epoch details using the getEpoch function based on chainId, marketAddress (Foil contract),
 * and marketId (epochId) to return its poolAddress.
 */
export async function resolvePoolAddress(
  params: PoolResolverParams
): Promise<string> {
  const { chainId, marketAddress, marketId, rpcUrl: providedRpcUrl } = params;

  let rpcUrl = providedRpcUrl;

  if (!rpcUrl) {
    rpcUrl = RPC_URLS[chainId];
    if (!rpcUrl) {
      console.error(`[PoolResolver] RPC URL not configured for chainId: ${chainId} and none was provided.`);
      throw new Error(`RPC URL not configured for chainId: ${chainId} and none was provided. Cannot resolve market ${marketId}.`);
    }
    console.log(`[PoolResolver] Using default RPC URL for chainId ${chainId}: ${rpcUrl}`);
  } else {
    console.log(`[PoolResolver] Using provided RPC URL: ${rpcUrl}`);
  }

  try {
    const transport = http(rpcUrl);
    const publicClient = createPublicClient({
      transport,
    });

    console.log(
      `[PoolResolver] Querying getEpoch for marketId (epochId): ${marketId} on contract ${marketAddress} (chainId: ${chainId}) using viem`
    );

    const getEpochResult = await publicClient.readContract({
      address: marketAddress as `0x${string}`,
      abi: foilContractAbi,
      functionName: 'getEpoch',
      args: [BigInt(marketId)],
    });
    
    // The ABI specifies getEpoch returns a tuple: [epochData, params]
    // epochData (the first element) is a struct that contains the 'pool' address.
    const epochData = getEpochResult[0]; 

    if (!epochData || !epochData.pool) {
      console.error('[PoolResolver] Invalid epochData or pool address not found in viem response:', epochData);
      throw new Error(
        `Pool address not found for market ${marketId} on chain ${chainId} at contract ${marketAddress}. Received: ${JSON.stringify(epochData)}`
      );
    }

    const poolAddress = epochData.pool as string;

    if (!isAddress(poolAddress) || poolAddress === zeroAddress) {
        console.error(`[PoolResolver] Resolved pool address is invalid or zero address: ${poolAddress}`);
        throw new Error(
            `Resolved pool address for market ${marketId} on chain ${chainId} is invalid: ${poolAddress}`
        );
    }
    
    console.log(
      `[PoolResolver] Resolved pool address for market ${marketId} on chain ${chainId} (contract ${marketAddress}): ${poolAddress}`
    );
    return poolAddress;

  } catch (error: any) {
    console.error(
      `[PoolResolver] Error fetching pool address for market ${marketId} on chain ${chainId} from contract ${marketAddress} using viem:`,
      error
    );
    // Viem errors often have a 'shortMessage' or 'message'
    const errorMessage = error.shortMessage || error.message || 'Unknown contract error with viem';
    throw new Error(
      `On-chain request failed for market ${marketId} on chain ${chainId} using viem: ${errorMessage}`
    );
  }
}
 