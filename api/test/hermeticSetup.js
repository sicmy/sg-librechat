/** The agent test gate must never load an actual env file, including .env.test. */
jest.mock('dotenv', () => ({
  ...jest.requireActual('dotenv'),
  config: jest.fn(() => ({ parsed: {} })),
  configDotenv: jest.fn(() => ({ parsed: {} })),
}));

require('./jestSetup');
