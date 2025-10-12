import pino from 'pino';
import { config } from './config';
import { getUnnotifiedAnomalies, markAnomalyAsNotified } from './anomaly-detector';
import { getAnomalySettings } from './db';
import type { Anomaly } from './types';

const logger = pino({ level: config.LOG_LEVEL });

/**
 * Форматирует сообщение об аномалии
 */
export function formatAnomalyMessage(anomaly: Anomaly & { game_title: string; game_url: string }): string {
  const settings = getAnomalySettings();
  
  // Если есть кастомное сообщение, используем его с подстановкой переменных
  if (settings.custom_message) {
    const direction = anomaly.direction === 'up' ? '📈 РОСТ' : '📉 ПАДЕНИЕ';
    const deltaSign = anomaly.delta > 0 ? '+' : '';
    const nSigma = config.ANOMALY_N_SIGMA;
    
    return settings.custom_message
      .replace(/\{game_title\}/g, anomaly.game_title)
      .replace(/\{direction\}/g, direction)
      .replace(/\{delta\}/g, `${deltaSign}${Math.round(anomaly.delta)}`)
      .replace(/\{n_sigma\}/g, nSigma.toString())
      .replace(/\{threshold\}/g, Math.round(anomaly.threshold).toString())
      .replace(/\{current_online\}/g, Math.round(anomaly.mean + anomaly.delta).toString())
      .replace(/\{mean\}/g, Math.round(anomaly.mean).toString())
      .replace(/\{stddev\}/g, Math.round(anomaly.stddev).toString())
      .replace(/\{game_url\}/g, anomaly.game_url)
      .replace(/\{timestamp\}/g, new Date(anomaly.timestamp).toLocaleString('ru-RU'));
  }
  
  // Стандартное сообщение
  const direction = anomaly.direction === 'up' ? '📈 РОСТ' : '📉 ПАДЕНИЕ';
  const deltaSign = anomaly.delta > 0 ? '+' : '';
  const nSigma = config.ANOMALY_N_SIGMA;
  
  return `🚨 АНОМАЛИЯ ОБНАРУЖЕНА!\n\n` +
    `🎮 Игра: ${anomaly.game_title}\n` +
    `📊 Направление: ${direction}\n` +
    `📈 Δ: ${deltaSign}${Math.round(anomaly.delta)} (${nSigma}σ=${Math.round(anomaly.threshold)})\n` +
    `👥 Текущий онлайн: ${Math.round(anomaly.mean + anomaly.delta)}\n` +
    `📊 Среднее: ${Math.round(anomaly.mean)}\n` +
    `📏 σ: ${Math.round(anomaly.stddev)}\n` +
    `🔗 Ссылка: ${anomaly.game_url}\n` +
    `⏰ Время: ${new Date(anomaly.timestamp).toLocaleString('ru-RU')}`;
}

/**
 * Отправляет уведомление в Telegram
 */
async function sendTelegramNotification(message: string): Promise<boolean> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    logger.warn('Telegram не настроен, уведомление не отправлено');
    return false;
  }
  
  try {
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }
    
    logger.info({ messageId: result.result.message_id }, 'Уведомление отправлено в Telegram');
    return true;
    
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Ошибка при отправке уведомления в Telegram');
    return false;
  }
}

/**
 * Отправляет все неотправленные аномалии
 */
export async function sendAnomalyNotifications(): Promise<{ sent: number; errors: number }> {
  let sent = 0;
  let errors = 0;
  
  try {
    const unnotifiedAnomalies = getUnnotifiedAnomalies();
    
    if (unnotifiedAnomalies.length === 0) {
      logger.debug('Нет неотправленных аномалий');
      return { sent: 0, errors: 0 };
    }
    
    logger.info({ count: unnotifiedAnomalies.length }, 'Отправляем уведомления об аномалиях');
    
    for (const anomaly of unnotifiedAnomalies) {
      try {
        const message = formatAnomalyMessage(anomaly);
        const success = await sendTelegramNotification(message);
        
        if (success) {
          markAnomalyAsNotified(anomaly.id!);
          sent++;
          logger.info({ anomalyId: anomaly.id, gameTitle: anomaly.game_title }, 'Уведомление об аномалии отправлено');
        } else {
          errors++;
          logger.error({ anomalyId: anomaly.id }, 'Не удалось отправить уведомление об аномалии');
        }
        
        // Небольшая задержка между отправками для избежания спама
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        errors++;
        logger.error({ 
          anomalyId: anomaly.id, 
          error: (error as Error).message 
        }, 'Ошибка при обработке аномалии');
      }
    }
    
    logger.info({ sent, errors }, 'Отправка уведомлений завершена');
    
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Ошибка при отправке уведомлений');
    errors++;
  }
  
  return { sent, errors };
}

/**
 * Отправляет тестовое уведомление
 */
export async function sendTestNotification(): Promise<boolean> {
  const testMessage = `🧪 ТЕСТОВОЕ УВЕДОМЛЕНИЕ\n\n` +
    `✅ Система мониторинга аномалий Roblox работает!\n` +
    `⏰ Время: ${new Date().toLocaleString('ru-RU')}\n` +
    `🔧 Настройки: Nσ=${config.ANOMALY_N_SIGMA}, мин.точек=${config.MIN_POINTS_IN_WINDOW}`;
  
  return await sendTelegramNotification(testMessage);
}
