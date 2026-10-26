import { existsSync } from 'node:fs';

/*
 * Second import of every entry point and CLI (after force-utc): loads `.env` into process.env with
 * Node's built-in parser, so module definitions that read feature switches (`features.stripe()`)
 * see the same values as the config module. Real environment variables always win; production
 * images ship without a `.env` file.
 */
if (existsSync('.env') && process.env.NODE_ENV !== 'test') process.loadEnvFile('.env');
