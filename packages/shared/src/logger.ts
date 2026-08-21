import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV !== 'production';

export const logger = pino(
  pretty
    ? { level, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : { level },
);

export type Logger = typeof logger;
