import pLimit from 'p-limit';
import pino from 'pino';
import 'dotenv/config';
import { config } from './config';
import { initSchema, upsertGame, upsertGameWithStatus, db } from './db';
import { fetchGamesByLetter, fetchGamesByLetterPage } from './rotrends';
import { closeBrowser } from './browser';

const logger = pino({ level: config.LOG_LEVEL });

// Только кириллический алфавит для парсинга русских игр
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
              
              // Снапшоты создаются только при "Поиск аномалий", не при парсинге игр
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


export async function populate(): Promise<void> {
  initSchema();
  await populateByLetters();
}

export async function parseNewGames(): Promise<{
  totalGames: number;
  newGames: number;
  updatedGames: number;
  errors: number;
  realGameCount: number;
}> {
  initSchema();
  
  let totalGames = 0;
  let newGames = 0;
  let updatedGames = 0;
  let errors = 0;
  
  const limit = pLimit(config.CONCURRENCY);
  
  // Парсинг по буквам
  for (const letter of LETTERS) {
    try {
      let page = 1;
      for (;;) {
        const pageGames = page === 1 ? await fetchGamesByLetter(letter) : await fetchGamesByLetterPage(letter, page);
        if (!pageGames.length) break;
        
        totalGames += pageGames.length;
        
        await Promise.all(
          pageGames.map((g) =>
            limit(async () => {
              try {
                const result = upsertGameWithStatus({ source_id: g.source_id, title: g.title, url: g.url });
                
                // Правильно считаем новые и обновленные игры
                if (result.isNew) {
                  newGames++;
                } else {
                  updatedGames++;
                }
                
                // Снапшоты создаются только при "Поиск аномалий", не при парсинге игр
              } catch (e) {
                errors++;
                logger.warn({ source_id: g.source_id, err: (e as Error).message }, 'Failed to process game');
              }
            })
          )
        );
        page += 1;
      }
    } catch (e) {
      errors++;
      logger.warn({ letter, err: (e as Error).message }, 'Failed to process letter');
    }
  }
  
  
  // Получаем реальное количество игр в базе данных
  const realGameCount = db.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
  
  return {
    totalGames,
    newGames,
    updatedGames,
    errors,
    realGameCount: realGameCount.count
  };
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


