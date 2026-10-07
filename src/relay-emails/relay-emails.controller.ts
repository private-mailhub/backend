import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { RelayEmailsService } from './relay-emails.service';
import { UsersService } from '../users/users.service';
import { CreateCustomRelayDto } from './dto/create-custom-relay.dto';
import { UpdateDescriptionDto } from './dto/update-description.dto';
import { UpdateActiveStatusDto } from './dto/update-active-status.dto';
import { CurrentUser, type CurrentUserPayload } from '../common/decorators/current-user.decorator';
import { RelayEmail } from './entities/relay-email.entity';
import { CreateRelayDto } from './dto/create-relay.dto';
import { ApiKeyAccess } from '../common/decorators/api-key-access.decorator';

@Controller('relay-emails')
export class RelayEmailsController {
  private readonly logger = new Logger(RelayEmailsController.name);
  constructor(
    private relayEmailsService: RelayEmailsService,
    private usersService: UsersService,
  ) {}

  @Get()
  @ApiKeyAccess('relay:read')
  @HttpCode(HttpStatus.OK)
  async getRelayEmails(@CurrentUser() user: CurrentUserPayload) {
    const relayEmails = await this.relayEmailsService.findByUser(user.userId);

    return relayEmails.map((relayEmail) => ({
      id: relayEmail.id.toString(),
      relayEmail: relayEmail.relayEmail,
      primaryEmail: relayEmail.primaryEmail,
      description: relayEmail.description,
      isActive: relayEmail.isActive,
      forwardCount: relayEmail.forwardCount.toString(),
      lastForwardedAt: relayEmail.lastForwardedAt,
      createdAt: relayEmail.createdAt,
    }));
  }

  @Post('create')
  @ApiKeyAccess('relay:write')
  @HttpCode(HttpStatus.CREATED)
  async createRelayEmail(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto?: CreateRelayDto,
  ): Promise<{
    id: string;
    relayEmail: string;
    isActive: boolean;
    description: string | null;
    createdAt: Date;
  }> {
    // Check subscription tier and limit
    const userEntity = await this.usersService.findById(currentUser.userId);
    if (!userEntity) {
      throw new NotFoundException('User not found');
    }

    const relayEmailEntity = await this.relayEmailsService.generateRelayEmailAddress(
      userEntity,
      dto?.description,
    );
    return {
      id: relayEmailEntity.id.toString(),
      relayEmail: relayEmailEntity.relayEmail,
      isActive: relayEmailEntity.isActive,
      description: relayEmailEntity.description,
      createdAt: relayEmailEntity.createdAt,
    };
  }

  @Post('custom')
  @HttpCode(HttpStatus.CREATED)
  async createCustomRelayEmail(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateCustomRelayDto,
  ): Promise<Partial<RelayEmail>> {
    // Get user entity to get primary email
    const userEntity = await this.usersService.findById(user.userId);
    if (!userEntity) {
      throw new NotFoundException('User not found');
    }

    const relayEmailEntity = await this.relayEmailsService.generateCustomRelayEmailAddress(
      userEntity,
      dto.customUsername,
    );

    return {
      relayEmail: relayEmailEntity.relayEmail,
      isActive: relayEmailEntity.isActive,
      description: relayEmailEntity.description,
      createdAt: relayEmailEntity.createdAt,
    };
  }

  @Patch(':id/description')
  @ApiKeyAccess('relay:write')
  @HttpCode(HttpStatus.OK)
  async updateDescription(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateDescriptionDto,
  ) {
    const relayEmail = await this.relayEmailsService.updateDescription(
      BigInt(id),
      user.userId,
      dto.description,
    );

    return {
      relayEmail: relayEmail.relayEmail,
      description: relayEmail.description,
    };
  }

  @Patch(':id/active')
  @ApiKeyAccess('relay:write')
  @HttpCode(HttpStatus.OK)
  async updateActiveStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateActiveStatusDto,
  ) {
    const relayEmail = await this.relayEmailsService.updateActiveStatus(
      BigInt(id),
      user.userId,
      dto.isActive,
    );

    return {
      relayEmail: relayEmail.relayEmail,
      isActive: relayEmail.isActive,
    };
  }
}
