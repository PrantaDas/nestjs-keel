import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessValidator } from '@/common/auth/access-validator';
import { UserDirectory } from '@/common/contracts/user-directory.contract';
import { QueueName } from '@/infra/queue/queue.constants';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { OtpDeliveryProcessor } from './otp/otp-delivery.processor';
import { OtpService } from './otp/otp.service';
import { SessionService } from './sessions/session.service';
import { SessionStore } from './sessions/session.store';
import { AccountDeletionCron } from './users/account-deletion.cron';
import { AccountDeletionProcessor } from './users/account-deletion.processor';
import { AdminUsersController } from './users/admin-users.controller';
import { User, UserSchema } from './users/schemas/user.schema';
import { UsersController } from './users/users.controller';
import { UsersRepository } from './users/users.repository';
import { UsersService } from './users/users.service';

const identityQueues = BullModule.registerQueue({ name: QueueName.OTP_DELIVERY }, { name: QueueName.ACCOUNT_DELETION });

/**
 * Accounts, sessions, codes and sign-in for every process (the guards of api, graphql and socket
 * need `AccessValidator`; other modules need `UserDirectory`). Global so both ports resolve
 * anywhere; nothing else is exported.
 */
@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]), identityQueues],
  providers: [
    UsersRepository,
    UsersService,
    SessionStore,
    SessionService,
    OtpService,
    AuthService,
    { provide: AccessValidator, useExisting: SessionService },
    { provide: UserDirectory, useExisting: UsersService },
  ],
  exports: [AccessValidator, UserDirectory, UsersService, AuthService, SessionService, identityQueues],
})
export class IdentityCoreModule {}

/** REST routes (api process). */
@Module({
  imports: [IdentityCoreModule],
  controllers: [AuthController, UsersController, AdminUsersController],
})
export class IdentityApiModule {}

/** Code delivery and account deletion (worker process). */
@Module({
  imports: [IdentityCoreModule],
  providers: [OtpDeliveryProcessor, AccountDeletionProcessor],
})
export class IdentityJobsModule {}

/** Deletion sweep (cron process). */
@Module({
  imports: [IdentityCoreModule],
  providers: [AccountDeletionCron],
})
export class IdentityCronModule {}
