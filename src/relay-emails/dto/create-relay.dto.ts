import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateRelayDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  description?: string;
}
