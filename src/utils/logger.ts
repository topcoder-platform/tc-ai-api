import { PinoLogger } from '@mastra/loggers';

export const tcAILogger = new PinoLogger({
    name: 'TC AI API',
    level: 'info',
});
