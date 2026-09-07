import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { User } from '../users/entities/user.entity';
import { RelayEmail } from '../relay-emails/entities/relay-email.entity';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([User, RelayEmail]), UsersModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
