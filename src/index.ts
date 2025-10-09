import 'dotenv/config';
import pino from 'pino';
import { config } from './config';
import { initSchema } from './db';
import { populate } from './populate';
import { closeBrowser } from './browser';

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  initSchema();
  logger.info({ env: config.NODE_ENV }, 'Roblox monitor started');
  
  try {
    await populate();
    logger.info('Populate completed');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Populate failed');
  } finally {
    await closeBrowser();
  }
}

main().catch((error) => {
  // Log unhandled errors and exit non-zero for visibility
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});


