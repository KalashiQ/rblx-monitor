import { Telegraf, Markup } from 'telegraf';
import { config } from './config';
import { parseNewGames } from './populate';
import { db } from './db';
import * as fs from 'fs';
import * as path from 'path';

export class TelegramBot {
  private bot: Telegraf;

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
        'Используйте кнопки ниже для навигации.',
        this.getMainKeyboard()
      );
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
      await ctx.answerCbQuery('🚨 Поиск аномалий...');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    await ctx.reply(
      '🚨 Функция поиска аномалий пока не реализована.\n\n' +
      'Эта функция будет добавлена в следующих версиях.',
      this.getMainKeyboard()
    );
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
