import type { mongo } from 'mongoose';
import { dayKeyOf } from '@/common/time/zoned-time';
import { MigrationDefinition } from '../migration.types';
import { forEachBatch } from '../migration.utils';

/**
 * Example migration (docs/conventions/database.md "Migrations"): gives every note without a
 * `createdDay` the business day of its `createdAt`, as notes written by the app store it.
 *
 * - idempotent: only documents still missing the field are touched;
 * - batched: 1000 documents per round trip, never the whole collection in memory;
 * - raw collection, no app model (the model may change after this migration is written);
 * - dry run: counts and reports, writes nothing;
 * - real down: removes the field from exactly the documents this migration filled (marked).
 */
const MARK = '_backfilledCreatedDay';

const migration: MigrationDefinition = {
  description: 'notes: backfill createdDay from createdAt in the business time zone',

  async up({ db, dryRun, logger, businessTimeZone }) {
    const notes = db.collection('notes');
    const filter: mongo.Filter<mongo.Document> = { createdDay: { $exists: false } };
    if (dryRun) {
      logger.log('Would backfill createdDay', { count: await notes.countDocuments(filter), zone: businessTimeZone });
      return;
    }
    const migrated = await forEachBatch(notes, filter, 1000, async (docs) => {
      await notes.bulkWrite(
        docs.map((doc) => ({
          updateOne: {
            filter: { _id: doc._id, createdDay: { $exists: false } },
            update: { $set: { createdDay: dayKeyOf(doc.createdAt as Date, businessTimeZone), [MARK]: true } },
          },
        })),
        { ordered: false },
      );
    });
    logger.log('Backfilled createdDay', { migrated });
  },

  async down({ db, dryRun, logger }) {
    const notes = db.collection('notes');
    const filter = { [MARK]: true };
    if (dryRun) {
      logger.log('Would remove backfilled createdDay', { count: await notes.countDocuments(filter) });
      return;
    }
    const { modifiedCount } = await notes.updateMany(filter, { $unset: { createdDay: '', [MARK]: '' } });
    logger.log('Removed backfilled createdDay', { reverted: modifiedCount });
  },
};

export default migration;
