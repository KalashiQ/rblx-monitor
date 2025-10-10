import pLimit from 'p-limit';
import pino from 'pino';
import 'dotenv/config';
import { config } from './config';
import { initSchema, upsertGame } from './db';
import { fetchGamesByLetter, fetchGamesByPage, fetchGamesByLetterPage } from './rotrends';
import { insertSnapshot } from './db';
import { closeBrowser } from './browser';

const logger = pino({ level: config.LOG_LEVEL });

const LETTERS = [
  'а','б','в','г','д','е','ж','з','и','й','к','л','м','н','о','п','р','с','т','у','ф','х','ц','ч','ш','щ','ъ','ы','ь','э','ю','я'
];

async function populateByLetters(): Promise<void> {
  const limit = pLimit(config.CONCURRENCY);
  for (const letter of LETTERS) {
    try {
      // Первая страница
      let page = 1;
      for (;;) {
        const pageGames = page === 1 ? await fetchGamesByLetter(letter) : await fetchGamesByLetterPage(letter, page);
        logger.info({ letter, page, count: pageGames.length }, 'Fetched games by letter/page');
        if (!pageGames.length) break;
        await Promise.all(
          pageGames.map((g) =>
            limit(async () => {
              const gameId = upsertGame({ source_id: g.source_id, title: g.title, url: g.url });
              logger.debug({ gameId, source_id: g.source_id }, 'Upserted game');
              
              // Если есть CCU, сразу сохраняем снапшот
              if (g.ccu !== null && g.ccu !== undefined) {
                insertSnapshot({ game_id: gameId, timestamp: Date.now(), ccu: g.ccu });
                logger.debug({ gameId, ccu: g.ccu }, 'Snapshot saved');
              }
            })
          )
        );
        page += 1;
      }
    } catch (e) {
      logger.warn({ letter, err: (e as Error).message }, 'Failed to process letter');
    }
  }
}

async function populateByPages(maxPages = 10, pageSize = 50): Promise<void> {
  const limit = pLimit(config.CONCURRENCY);
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const games = await fetchGamesByPage(page, pageSize);
      if (!games.length) {
        logger.info({ page }, 'No more games, stopping pagination');
        break;
      }
      logger.info({ page, count: games.length }, 'Fetched games by page');
      await Promise.all(
        games.map((g) =>
          limit(async () => {
            const id = upsertGame({ source_id: g.source_id, title: g.title, url: g.url });
            logger.debug({ id, source_id: g.source_id }, 'Upserted game');
          })
        )
      );
    } catch (e) {
      logger.warn({ page, err: (e as Error).message }, 'Failed to process page');
    }
  }
}

export async function populate(): Promise<void> {
  initSchema();
  await populateByLetters();
  await populateByPages(20, 50);
}

if (require.main === module) {
  populate()
    .then(() => {
      logger.info('Populate completed');
      return closeBrowser();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}


