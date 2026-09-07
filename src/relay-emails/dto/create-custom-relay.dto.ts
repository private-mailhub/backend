import { IsNotEmpty, IsString, Matches } from 'class-validator';
import {
  RELAY_USERNAME_PATTERN,
  RELAY_USERNAME_ERROR_MESSAGE,
} from '../../common/utils/relay-email.util';

export class CreateCustomRelayDto {
  @IsNotEmpty()
  @IsString()
  @Matches(RELAY_USERNAME_PATTERN, {
    message: RELAY_USERNAME_ERROR_MESSAGE,
  })
  customUsername: string;
}
