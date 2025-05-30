# Sapience Helpers

**This is a vibecoded prototype, proof-of-concept, work-in-progress**

A Typescript library with useful functions for interacting with [Sapience](https://www.sapience.xyz) markets.

* **Market Observer** - Listen to a market's Uniswap pool via websockets and stream the latest price and orderbook data.
* **New Market Alerts** - *Coming soon.* Poll the Sapience API's GraphQL endpoint for new market groups and markets.
* **Limit Orders** - *Coming soon.* Collect a signed trade and watch the market for an opportunity to submit it.

---

## Installation

```bash
pnpm add sapience-helpers
```

The package ships with TypeScript typings out of the box.

---

## Market Observer Example

```ts
import { SapienceMarketObserver, Order } from 'sapience-helpers';

async function main() {
  const observer = new SapienceMarketObserver({
    chainId: 8453,
    marketAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    marketId: 2
    // Optional, Provide a WebSocket RPC URL. (If omitted, uses viem's default public WebSocket for the specified chainId.)
    // rpcUrl: process.env.INFURA_MAINNET_WSS_URL
  });

  observer.on('marketPriceUpdated', (data: number) => {
    console.log('[New Market Price]: ', data);
  });

  observer.on('orderBookUpdated', (data: Order[]) => {
    console.log('[New Orderbook Composition]: ', data);
  });

  observer.on('error', (error: Error) => {
    console.error('[OBSERVER ERROR]:', error);
  });

  try {
    await observer.start();
    console.log('Market observer started successfully. Waiting for events...');
  } catch (error) {
    console.error('Failed to start market observer:', error);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down observer...');
    observer.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown); // CTRL+C
  process.on('SIGTERM', shutdown);

  // Keep the main process running to listen for events
  // This might not be needed if your app has other long-running processes (e.g., a server)
  // To keep it running indefinitely for this example:
  new Promise(() => {}); 
}

main().catch(error => {
  console.error('Unhandled error in main application:', error);
  process.exit(1);
});
```

## License

MIT