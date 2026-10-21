import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./src/keycloak.test-setup.ts'],
        include: ['src/**/*.test.ts'],
        clearMocks: true,
        restoreMocks: true,
    },
});
