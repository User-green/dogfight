// One structured JSON logger (pino) writing to stdout: the platform collects stdout, we never manage log files here.
import pino from 'pino';

/** Silent under test (vitest sets NODE_ENV=test); otherwise LOG_LEVEL (validated again by loadConfig), default info. */
export const log = pino({ level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'), base: { app: 'dogfight' } });
