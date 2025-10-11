import { Telegraf, Markup } from 'telegraf';
import { config } from './config';
import { parseNewGames } from './populate';
import { db } from './db';
import { startCircularParsingForDuration } from './roblox-parser';
import * as fs from 'fs';
import * as path from 'path';

export class TelegramBot {
  private bot: Telegraf;
  private isParsingActive: boolean = false;
  private parsingStartTime: number = 0;
  private parsingStats: {
    totalProcessed: number;
    successfulParses: number;
    failedParses: number;
    lastGameTitle: string;
    completedCycles: number;
    lastGameIndex: number;
  } = {
    totalProcessed: 0,
    successfulParses: 0,
    failedParses: 0,
    lastGameTitle: '',
    completedCycles: 0,
    lastGameIndex: -1
  };

  constructor() {
    console.log('🤖 Creating TelegramBot instance...');
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }
    
    console.log('🔑 Bot token found:', config.TELEGRAM_BOT_TOKEN.substring(0, 10) + '...');
    this.bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
    this.setupHandlers();
    console.log('✅ TelegramBot instance created');
  }

  private setupHandlers() {
    console.log('🔧 Setting up handlers...');
    
    // Команда /start
    this.bot.start((ctx) => {
      console.log('👋 /start command received');
      ctx.reply(
        '🤖 Добро пожаловать в Roblox Monitor Bot!\n\n' +
        'Этот бот поможет вам отслеживать аномалии в играх Roblox.',
        this.getMainKeyboard()
      );
    });

    // Команда /help
    this.bot.help((ctx) => {
      ctx.reply(
        '📋 Доступные команды:\n\n' +
        '🔍 Парсинг новых игр - запустить парсинг новых игр с Roblox\n' +
        '🚨 Запустить поиск аномалий - найти аномальные игры\n' +
        '⚙️ Настройки - настройки бота\n' +
        '📤 Экспорт файла базы данных - скачать базу данных\n\n' +
        '📊 /status - показать статус парсинга\n' +
        '🛑 /stop_parsing - остановить парсинг аномалий\n\n' +
        'Используйте кнопки ниже для навигации.',
        this.getMainKeyboard()
      );
    });

    // Команда /stop_parsing
    this.bot.command('stop_parsing', (ctx) => {
      console.log('🛑 stop_parsing command received');
      this.handleStopParsing(ctx);
    });

    // Команда /status
    this.bot.command('status', (ctx) => {
      console.log('📊 status command received');
      this.handleStatus(ctx);
    });

    // Обработчики кнопок
    this.bot.action('parse_games', (ctx) => {
      console.log('🔍 parse_games action triggered');
      this.handleParseGames(ctx);
    });
    this.bot.action('find_anomalies', (ctx) => {
      console.log('🚨 find_anomalies action triggered');
      this.handleFindAnomalies(ctx);
    });
    this.bot.action('settings', (ctx) => {
      console.log('⚙️ settings action triggered');
      this.handleSettings(ctx);
    });
    this.bot.action('export_db', (ctx) => {
      console.log('📤 export_db action triggered');
      this.handleExportDb(ctx);
    });
    this.bot.action('back_to_main', (ctx) => {
      console.log('🏠 back_to_main action triggered');
      this.handleBackToMain(ctx);
    });
    this.bot.action('cancel_parsing', (ctx) => {
      console.log('🛑 cancel_parsing action triggered');
      this.handleStopParsing(ctx);
    });

    // Обработка ошибок
    this.bot.catch((err, ctx) => {
      console.error('Telegram bot error:', err);
      ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    });
  }

  private getMainKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Парсинг новых игр', 'parse_games')],
      [Markup.button.callback('🚨 Запустить поиск аномалий', 'find_anomalies')],
      [Markup.button.callback('⚙️ Настройки', 'settings')],
      [Markup.button.callback('📤 Экспорт файла базы данных', 'export_db')]
    ]);
  }

  private async handleParseGames(ctx: any) {
    console.log('🔍 Parse games button clicked');
    try {
      // Отвечаем на callback query только если это возможно
      try {
        console.log('📤 Answering callback query...');
        await ctx.answerCbQuery('🔄 Начинаем парсинг...', { show_alert: false });
      } catch (cbError) {
        console.log('⚠️ Callback query already answered or expired, continuing...');
      }
      
      // Отправляем новое сообщение вместо редактирования
      console.log('📝 Sending new message...');
      await ctx.reply('🔄 Парсинг новых игр...\n\n⏳ Это может занять несколько минут.');

      // Запускаем парсинг в фоне
      console.log('🚀 Starting parseNewGames...');
      const result = await parseNewGames();
      console.log('✅ Parse completed:', result);
      
      // Отправляем новое сообщение с результатами
      console.log('📨 Sending results...');
      await ctx.reply(
        `✅ Парсинг завершен!\n\n` +
        `🆕 Новых игр: ${result.newGames}\n` +
        `📊 Всего в базе: ${result.realGameCount}\n` +
        `❌ Ошибок: ${result.errors}`,
        this.getMainKeyboard()
      );
      console.log('✅ Results sent successfully');
    } catch (error) {
      console.error('❌ Parse games error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при парсинге игр. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleFindAnomalies(ctx: any) {
    try {
      await ctx.answerCbQuery('🚨 Запуск поиска аномалий...', { show_alert: false });
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    // Проверяем, не запущен ли уже парсинг
    if (this.isParsingActive) {
      await ctx.reply(
        '⚠️ Парсинг уже запущен!\n\n' +
        '🔄 Круговой парсинг онлайна игр уже работает.\n' +
        '🛑 Для остановки используйте команду /stop_parsing',
        this.getMainKeyboard()
      );
      return;
    }
    
    try {
      // Устанавливаем флаг активного парсинга и сбрасываем статистику
      this.isParsingActive = true;
      this.parsingStartTime = Date.now();
      this.parsingStats = {
        totalProcessed: 0,
        successfulParses: 0,
        failedParses: 0,
        lastGameTitle: '',
        completedCycles: 0,
        lastGameIndex: -1
      };
      
      // Создаем клавиатуру с кнопкой отмены
      const parsingKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🛑 Остановить парсинг', 'cancel_parsing')]
      ]);
      
      // Отправляем сообщение о начале процесса
      await ctx.reply(
        '🚨 Запуск поиска аномалий...\n\n' +
        '🔄 Начинаем круговой парсинг онлайна игр с официального сайта Roblox.\n' +
        '⏳ Парсинг будет работать круглосуточно до остановки.\n\n' +
        '🛑 Для остановки нажмите кнопку ниже или используйте команду /stop_parsing',
        parsingKeyboard
      );

      // Запускаем круговой парсинг на 24 часа (86400000 мс) - практически бесконечно
      const durationMs = 24 * 60 * 60 * 1000; // 24 часа
      let progressMessage: any = null;
      let lastUpdateTime = 0;
      
      const result = await startCircularParsingForDuration(
        durationMs,
        (current, total, gameTitle, successfulParses, failedParses) => {
          // Проверяем, не остановлен ли парсинг
          if (!this.isParsingActive) {
            return;
          }
          
          // Обновляем статистику
          this.parsingStats.totalProcessed = current;
          this.parsingStats.lastGameTitle = gameTitle;
          this.parsingStats.successfulParses = successfulParses;
          this.parsingStats.failedParses = failedParses;
          
          // Если вернулись к первой игре (current === 1) и предыдущая игра была последней в списке
          if (current === 1 && this.parsingStats.lastGameIndex === total) {
            this.parsingStats.completedCycles++;
          }
          
          // Сохраняем текущий индекс игры
          this.parsingStats.lastGameIndex = current;
          
          const now = Date.now();
          const elapsedTime = now - this.parsingStartTime;
          const elapsedMinutes = Math.floor(elapsedTime / 60000);
          
          // Обновляем прогресс каждые 5 игр или каждые 10 секунд
          if (current % 5 === 0 || current === 1 || now - lastUpdateTime > 10000) {
            lastUpdateTime = now;
            
            const progressText = `🚨 Поиск аномалий (КРУГЛОСУТОЧНО)...\n\n` +
              `🔄 Обработано игр: ${current}/${total}\n` +
              `🎮 Текущая игра: ${gameTitle}\n` +
              `⏱️ Время работы: ${elapsedMinutes} мин\n` +
              `🔄 Завершено кругов: ${this.parsingStats.completedCycles}\n` +
              `📊 Успешно: ${this.parsingStats.successfulParses} | Ошибок: ${this.parsingStats.failedParses}\n` +
              `⏳ Парсинг продолжается...\n\n` +
              `🛑 Для остановки: /stop_parsing`;
            
            const progressKeyboard = Markup.inlineKeyboard([
              [Markup.button.callback('🛑 Остановить парсинг', 'cancel_parsing')]
            ]);
            
            if (progressMessage) {
              try {
                ctx.telegram.editMessageText(
                  ctx.chat!.id,
                  progressMessage.message_id,
                  undefined,
                  progressText,
                  { reply_markup: progressKeyboard.reply_markup }
                );
              } catch (editError) {
                console.log('⚠️ Could not update progress message:', editError);
              }
            } else {
              // Создаем первое сообщение о прогрессе
              ctx.telegram.sendMessage(
                ctx.chat!.id,
                progressText,
                { reply_markup: progressKeyboard.reply_markup }
              ).then((msg: any) => {
                progressMessage = msg;
              }).catch((err: any) => {
                console.log('⚠️ Could not send progress message:', err);
              });
            }
          }
        },
        () => !this.isParsingActive  // Callback для проверки остановки
      );

      // Сбрасываем флаг активного парсинга
      this.isParsingActive = false;

      // Отправляем финальные результаты
      await ctx.reply(
        `✅ Поиск аномалий завершен!\n\n` +
        `📊 Статистика:\n` +
        `🎮 Всего игр: ${result.totalGames}\n` +
        `✅ Успешно обработано: ${result.successfulParses}\n` +
        `❌ Ошибок: ${result.failedParses}\n` +
        `🔄 Полных циклов: ${result.totalCycles}\n` +
        `⏱️ Среднее время на игру: ${result.averageTimePerGame}мс\n` +
        `📈 Снапшоты сохранены в базу данных\n\n` +
        `🔍 Теперь можно анализировать данные на предмет аномалий.`,
        this.getMainKeyboard()
      );

      console.log('✅ Anomaly search completed:', result);
      
    } catch (error) {
      // Сбрасываем флаг активного парсинга при ошибке
      this.isParsingActive = false;
      console.error('❌ Anomaly search error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при поиске аномалий. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleSettings(ctx: any) {
    try {
      await ctx.answerCbQuery('⚙️ Настройки');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    await ctx.reply(
      '⚙️ Настройки бота\n\n' +
      '🔧 Функция настроек пока не реализована.\n\n' +
      'Здесь будут доступны:\n' +
      '• Настройка интервала мониторинга\n' +
      '• Настройка параметров аномалий\n' +
      '• Уведомления',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад', 'back_to_main')]
      ])
    );
  }

  private async handleExportDb(ctx: any) {
    try {
      try {
        await ctx.answerCbQuery('📤 Подготовка файла...', { show_alert: false });
      } catch (cbError) {
        console.log('⚠️ Callback query already answered or expired, continuing...');
      }
      await ctx.reply('📤 Подготовка файла базы данных...\n\n⏳ Пожалуйста, подождите.');

      console.log('🔄 Syncing database before export...');
      
      // Принудительно синхронизируем базу данных
      db.pragma('synchronous = FULL');
      db.pragma('journal_mode = DELETE');
      db.pragma('wal_checkpoint(FULL)');
      
      // Ждем немного, чтобы изменения записались
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Создаем временный файл с базой данных
      const dbPath = config.DB_PATH;
      const tempPath = path.join(__dirname, '..', 'temp_export.db');
      
      console.log('📁 Creating clean database export...');
      
      // Создаем новую базу данных с помощью VACUUM INTO
      // Это гарантирует, что все данные будут в одном файле
      try {
        db.prepare(`VACUUM INTO '${tempPath}'`).run();
        console.log('✅ VACUUM INTO completed successfully');
      } catch (vacuumError) {
        console.log('⚠️ VACUUM INTO failed, falling back to file copy');
        // Если VACUUM INTO не работает, используем обычное копирование
        fs.copyFileSync(dbPath, tempPath);
      }
      
      // Проверяем размер файла и количество игр
      const stats = fs.statSync(tempPath);
      console.log(`📊 Exported database size: ${stats.size} bytes`);
      
      // Проверяем количество игр в экспортированной базе
      let gameCount = 0;
      try {
        const tempDb = require('better-sqlite3')(tempPath);
        const countResult = tempDb.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
        gameCount = countResult.count;
        tempDb.close();
        console.log(`🎮 Games in exported database: ${gameCount}`);
      } catch (countError) {
        console.log('⚠️ Could not count games in exported database:', countError);
      }

      // Отправляем файл
      await ctx.replyWithDocument(
        { source: tempPath, filename: 'roblox_monitor.db' },
        {
          caption: '📤 Экспорт базы данных завершен!\n\n' +
                   `📊 Размер файла: ${Math.round(stats.size / 1024)} KB\n` +
                   `🎮 Игр в базе: ${gameCount}\n` +
                   'Файл содержит все данные о играх и их статистике.'
        }
      );

      // Удаляем временный файл
      fs.unlinkSync(tempPath);
      console.log('🗑️ Temporary file deleted');

      // Отправляем подтверждение
      await ctx.reply(
        '✅ Файл базы данных успешно экспортирован!',
        this.getMainKeyboard()
      );
    } catch (error) {
      console.error('❌ Export DB error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при экспорте базы данных. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleStatus(ctx: any) {
    try {
      const now = Date.now();
      const elapsedTime = this.parsingStartTime > 0 ? now - this.parsingStartTime : 0;
      const elapsedMinutes = Math.floor(elapsedTime / 60000);
      const elapsedHours = Math.floor(elapsedMinutes / 60);
      
      if (!this.isParsingActive) {
        await ctx.reply(
          '📊 Статус парсинга\n\n' +
          '🔴 Парсинг не активен\n\n' +
          '🚨 Для запуска используйте кнопку "Запустить поиск аномалий"',
          this.getMainKeyboard()
        );
        return;
      }

      const statusText = `📊 Статус парсинга\n\n` +
        `🟢 Парсинг активен\n` +
        `⏱️ Время работы: ${elapsedHours}ч ${elapsedMinutes % 60}м\n` +
        `🔄 Обработано игр: ${this.parsingStats.totalProcessed}\n` +
        `🔄 Завершено кругов: ${this.parsingStats.completedCycles}\n` +
        `📊 Успешно: ${this.parsingStats.successfulParses} | Ошибок: ${this.parsingStats.failedParses}\n` +
        `🎮 Последняя игра: ${this.parsingStats.lastGameTitle}\n\n` +
        `🛑 Для остановки: /stop_parsing`;
      
      await ctx.reply(statusText, this.getMainKeyboard());
      
    } catch (error) {
      console.error('❌ Status error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при получении статуса. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleStopParsing(ctx: any) {
    try {
      if (!this.isParsingActive) {
        await ctx.reply(
          '⚠️ Парсинг не запущен!\n\n' +
          '🔄 В данный момент круговой парсинг не активен.\n' +
          '🚨 Для запуска используйте кнопку "Запустить поиск аномалий"',
          this.getMainKeyboard()
        );
        return;
      }

      // Останавливаем парсинг
      this.isParsingActive = false;
      
      await ctx.reply(
        '🛑 Парсинг остановлен!\n\n' +
        '✅ Круговой парсинг онлайна игр был остановлен.\n' +
        `🔄 Завершено кругов: ${this.parsingStats.completedCycles}\n` +
        '📊 Все собранные данные сохранены в базу данных.\n\n' +
        '🚨 Для повторного запуска используйте кнопку "Запустить поиск аномалий"',
        this.getMainKeyboard()
      );
      
      console.log('🛑 Parsing stopped by user command');
    } catch (error) {
      console.error('❌ Stop parsing error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при остановке парсинга. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleBackToMain(ctx: any) {
    try {
      await ctx.answerCbQuery('🏠 Главное меню');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    await ctx.reply(
      '🤖 Roblox Monitor Bot\n\n' +
      'Выберите действие:',
      this.getMainKeyboard()
    );
  }

  public async start() {
    try {
      console.log('🚀 Launching Telegram bot...');
      await this.bot.launch();
      console.log('🤖 Telegram bot started successfully');
    } catch (error) {
      console.error('❌ Failed to start Telegram bot:', error);
      throw error;
    }
  }

  public async stop() {
    try {
      await this.bot.stop();
      console.log('🤖 Telegram bot stopped');
    } catch (error) {
      console.error('Error stopping Telegram bot:', error);
    }
  }
}
