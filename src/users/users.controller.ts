import { Controller, Get, Post, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { UsersService } from './users.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/decorators/current-user.decorator';
import { ChangeUsernameDto } from './dto/change-username.dto';
import { VerifyUsernameChangeDto } from './dto/verify-username-change.dto';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Public()
  @Get('exists/:username')
  @HttpCode(HttpStatus.OK)
  async checkUsernameExists(@Param('username') username: string): Promise<{ exists: boolean }> {
    const exists = await this.usersService.existsByUsername(username);
    return { exists };
  }

  @Post('/deactivate')
  async deactivateUser(@CurrentUser() user: CurrentUserPayload): Promise<{ message: string }> {
    await this.usersService.deactivateUser(user.userId);
    return { message: 'User deactivated successfully' };
  }

  @Delete('')
  @HttpCode(HttpStatus.OK)
  async deleteCurrentUser(@CurrentUser() user: CurrentUserPayload): Promise<{ message: string }> {
    await this.usersService.deleteUser(user.userId);
    return { message: 'User deleted successfully' };
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async getCurrentUser(@CurrentUser() user: CurrentUserPayload) {
    return await this.usersService.getUserInfo(user.userId);
  }

  @Post('change-username')
  @HttpCode(HttpStatus.OK)
  async requestUsernameChange(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ChangeUsernameDto,
  ): Promise<{ message: string }> {
    await this.usersService.requestUsernameChange(user.userId, dto.encryptedNewUsername);
    return { message: 'Verification code sent to new email' };
  }

  @Post('verify-username-change')
  @HttpCode(HttpStatus.OK)
  async verifyUsernameChange(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: VerifyUsernameChangeDto,
  ): Promise<{ message: string }> {
    await this.usersService.verifyUsernameChange(user.userId, dto.code);
    return { message: 'Username changed successfully' };
  }
}
