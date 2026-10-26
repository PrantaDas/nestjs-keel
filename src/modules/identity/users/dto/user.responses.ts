import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@/common/auth/auth.types';
import type { AccountStatus } from '@/common/contracts/user-directory.contract';
import { ApiDateTimeProperty, ApiMapProperty, ApiObjectIdProperty } from '@/common/swagger';

const STATUSES: AccountStatus[] = ['active', 'deactivated', 'deletion_pending', 'deleted'];

/** The signed-in person's own account (`GET /users/me`). */
export class UserResponse {
  @ApiObjectIdProperty()
  _id: string;

  @ApiProperty({ type: String, example: 'Ada Lovelace' })
  name: string;

  @ApiProperty({ type: String, nullable: true, example: 'ada@example.com' })
  email: string | null;

  @ApiProperty({ type: Boolean })
  emailVerified: boolean;

  @ApiProperty({ type: String, nullable: true, example: '+14155550123', description: 'E.164' })
  phone: string | null;

  @ApiProperty({ type: Boolean })
  phoneVerified: boolean;

  @ApiProperty({ type: String, enum: Role, enumName: 'Role' })
  role: Role;

  @ApiProperty({ type: String, enum: STATUSES, enumName: 'AccountStatus' })
  status: AccountStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Picture URL (signed, short-lived when the bucket is private)',
  })
  avatarUrl: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'en-GB' })
  locale: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Europe/London' })
  timeZone: string | null;

  @ApiProperty({ type: Boolean, description: 'Whether the account can sign in with a password' })
  hasPassword: boolean;

  @ApiDateTimeProperty({ nullable: true, description: 'When a requested deletion will run' })
  deletionDueAt: string | null;

  @ApiDateTimeProperty()
  createdAt: string;
}

/** Admin view: the account plus moderation fields. */
export class AdminUserResponse extends UserResponse {
  @ApiDateTimeProperty({ nullable: true })
  lastLoginAt: string | null;

  @ApiDateTimeProperty({ nullable: true })
  lockedUntil: string | null;

  @ApiDateTimeProperty({ nullable: true })
  deactivatedAt: string | null;
}

export class AdminUserSessionResponse {
  @ApiProperty({ type: String })
  _id: string;

  @ApiProperty({ type: String, example: 'iPhone 15' })
  device: string;

  @ApiProperty({ type: String, nullable: true })
  ip: string | null;

  @ApiDateTimeProperty()
  createdAt: string;

  @ApiDateTimeProperty()
  lastUsedAt: string;
}

export class AdminUserDetailResponse extends AdminUserResponse {
  @ApiProperty({ type: Number, description: 'Notes owned by the account (examples module, through its port)' })
  notesCount: number;

  @ApiProperty({ type: () => [AdminUserSessionResponse] })
  sessions: AdminUserSessionResponse[];
}

export class AvatarUploadResponse {
  @ApiProperty({ type: String, description: 'PUT the file here with the headers below' })
  uploadUrl: string;

  @ApiProperty({ type: String, enum: ['PUT'] })
  method: 'PUT';

  @ApiMapProperty({ type: 'string' }, { description: 'Send exactly these headers' })
  headers: Record<string, string>;

  @ApiProperty({ type: String, description: 'Send it back to `PUT /users/me/avatar` once uploaded' })
  key: string;

  @ApiDateTimeProperty()
  expiresAt: string;
}
