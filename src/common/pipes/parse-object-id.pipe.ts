import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { RequestErrors, RequestException } from '@/common/exceptions';
import { fieldLabel } from '@/common/messages/field-labels';

/** Rejects malformed ids in the path before they reach the database. */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (typeof value === 'string' && isValidObjectId(value) && /^[a-f\d]{24}$/i.test(value)) return value;
    const field = metadata.data ?? 'id';
    throw new RequestException(RequestErrors.INVALID_ID, {
      details: [{ field, message: `${fieldLabel(field)} isn't valid. Please check the link and try again.` }],
    });
  }
}
