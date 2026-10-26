import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ValidationException } from '@/common/exceptions';
import { IsDayKey } from '@/common/time';
import { createValidationPipe } from './validation.pipe';

enum Level {
  EASY = 'easy',
  HARD = 'hard',
}

class AddressDto {
  @IsString()
  city: string;
}

class SignupDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  email: string;

  @IsInt()
  @Min(13, { message: 'age must be at least 13' })
  age: number;

  @ValidateNested()
  @Type(() => AddressDto)
  address: AddressDto;
}

class NoteDto {
  @IsString({ message: 'title must be text' })
  @IsNotEmpty({ message: 'title is required' })
  @MaxLength(200, { message: 'title must be at most 200 characters long' })
  title: string;

  @IsOptional()
  @IsDayKey()
  day?: string;

  @IsOptional()
  @IsEnum(Level)
  level?: Level;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsMongoId({ each: true, message: 'each tag id must be a 24-character hex ObjectId' })
  tagIds?: string[];

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]+$/, { message: 'imageKey must be lower-case letters' })
  imageKey?: string;

  @IsOptional()
  @Matches(/^#/, { message: 'Pick a colour from the palette.' })
  colour?: string;
}

describe('createValidationPipe', () => {
  const pipe = createValidationPipe();
  const meta = (metatype: new () => object) => ({ type: 'body' as const, metatype });
  const details = async (metatype: new () => object, body: object) => {
    const error = await pipe.transform(body, meta(metatype)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationException);
    return (error as ValidationException).details!;
  };

  it('reports every failing field with dotted paths for nested objects', async () => {
    const found = await details(SignupDto, { email: 'nope', age: 5, address: { city: 1 }, isAdmin: true });
    expect(found.map((d) => d.field).sort()).toEqual(['address.city', 'age', 'email', 'isAdmin']);
    expect(found).toEqual(
      expect.arrayContaining([
        { field: 'email', message: 'Enter a valid email address.' },
        { field: 'age', message: 'Age must be 13 or more.' },
        { field: 'address.city', message: 'City must be text.' },
        { field: 'isAdmin', message: "This field isn't allowed." },
      ]),
    );
  });

  it('writes one human sentence per rule from the rule and its arguments', async () => {
    const found = await details(NoteDto, {
      title: 'x'.repeat(201),
      day: '12-10-2026',
      level: 'medium',
      tagIds: ['nope', '6addc5fdb0ff8815c044f1fa', 'x'],
    });
    expect(found).toEqual([
      { field: 'title', message: 'Title must be 200 characters or fewer.' },
      { field: 'day', message: 'Day must use the format YYYY-MM-DD, for example 2026-10-12.' },
      { field: 'level', message: 'Level must be one of: easy, hard.' },
      { field: 'tagIds', message: "Tags contains an item that isn't valid." },
      { field: 'tagIds', message: 'Tags can have at most 2 items.' },
    ]);
  });

  it('reports a missing field once as required, and a value of the wrong kind once', async () => {
    expect(await details(NoteDto, {})).toEqual([{ field: 'title', message: 'Title is required.' }]);
    expect(await details(NoteDto, { title: '' })).toEqual([{ field: 'title', message: 'Title is required.' }]);
    expect(await details(NoteDto, { title: 42 })).toEqual([{ field: 'title', message: 'Title must be text.' }]);
  });

  it('humanises the text of rules it does not know, and keeps sentences written for people', async () => {
    const found = await details(NoteDto, { title: 'Note', imageKey: 'BAD', colour: 'red' });
    expect(found).toEqual([
      { field: 'imageKey', message: 'Image must be lower-case letters.' },
      { field: 'colour', message: 'Pick a colour from the palette.' },
    ]);
  });

  it('returns a DTO instance for valid input', async () => {
    const value = (await pipe.transform(
      { email: 'a@b.co', age: 20, address: { city: 'Dhaka' } },
      meta(SignupDto),
    )) as SignupDto;
    expect(value).toBeInstanceOf(SignupDto);
  });
});
