// Vitest config — keeps test files .mjs because the project's lib code is CJS
// (require/module.exports) and we want the test runner to find both .js and
// .mjs locations without forcing the whole project to ESM.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.{js,mjs}'],
    },
});
