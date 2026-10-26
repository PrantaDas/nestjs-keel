import { ApiProperty } from '@nestjs/swagger';
import { ApiDateTimeProperty } from '@/common/swagger';
import { UserResponse } from '../../users/dto/user.responses';

export class TokenPairResponse {
  @ApiProperty({ type: String, description: 'Bearer token for every request' })
  accessToken: string;

  @ApiDateTimeProperty({ description: 'Refresh before this instant' })
  accessTokenExpiresAt: string;

  @ApiProperty({ type: String, description: 'Send to `POST /auth/refresh`; each one works once' })
  refreshToken: string;

  @ApiDateTimeProperty()
  refreshTokenExpiresAt: string;

  @ApiProperty({ type: String, description: 'This device session (sign out of it with `DELETE /auth/sessions/:id`)' })
  sessionId: string;
}

export class AuthResponse extends TokenPairResponse {
  @ApiProperty({ type: () => UserResponse })
  user: UserResponse;
}

export class SessionResponse {
  @ApiProperty({ type: String })
  _id: string;

  @ApiProperty({ type: String, example: 'iPhone 15' })
  device: string;

  @ApiProperty({ type: String, nullable: true })
  ip: string | null;

  @ApiProperty({ type: Boolean, description: 'The session making this request' })
  current: boolean;

  @ApiDateTimeProperty()
  createdAt: string;

  @ApiDateTimeProperty()
  lastUsedAt: string;

  @ApiDateTimeProperty()
  expiresAt: string;
}

export class SignedOutResponse {
  @ApiProperty({ type: Number, description: 'Sessions ended' })
  revoked: number;
}
