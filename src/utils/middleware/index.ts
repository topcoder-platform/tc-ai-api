import { resourceIdMiddleware } from './resourceIdMiddleware';

export * from './resourceIdMiddleware';
export const middlewareConfig: any[] = [];

// Only when auth is enabled
if (process.env.DISABLE_AUTH !== 'true') {
    middlewareConfig.push(resourceIdMiddleware);
}