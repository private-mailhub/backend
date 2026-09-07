import { IsString, MaxLength } from 'class-validator';

export class UpdateDescriptionDto {
  @IsString()
  @MaxLength(100, { message: 'Description must be less than 100 characters' })
  description: string;
}
