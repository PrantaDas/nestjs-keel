import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from './token.service';

/** Token issuing / verification shared by the HTTP and GraphQL guards and socket handshake auth. */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [TokenService],
  exports: [TokenService],
})
export class AuthCoreModule {}
