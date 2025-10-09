import 'dotenv/config';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main(): Promise<void> {
  logger.info({ env: process.env.NODE_ENV }, 'Roblox monitor started');
}

main().catch((error) => {
  // Log unhandled errors and exit non-zero for visibility
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});


