import multer from 'multer';
import { ZodError } from 'zod';

import { HttpError } from '../errors.js';

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: [413, 'file_too_large', 'One of the photos is too large.'],
  LIMIT_FILE_COUNT: [413, 'too_many_files', 'Too many photos in one memory.'],
  LIMIT_UNEXPECTED_FILE: [400, 'unexpected_file', 'Photos must be sent in the "photos" field.'],
};

/**
 * Turns every failure into one JSON shape: { error: { code, message, details? } }.
 * Unexpected errors are logged and reported without internals.
 */
export function errorHandler(logger) {
  // Express recognises error handlers by their four parameters.
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, _next) => {
    let status = 500;
    let body = { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' };

    if (error instanceof HttpError) {
      status = error.status;
      body = { code: error.code, message: error.message, details: error.details };
    } else if (error instanceof ZodError) {
      status = 400;
      body = {
        code: 'validation_failed',
        message: 'Some of the details sent are not valid.',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (error instanceof multer.MulterError) {
      const [s, code, message] = MULTER_MESSAGES[error.code] ?? [400, 'upload_failed', error.message];
      status = s;
      body = { code, message };
    } else if (error?.type === 'entity.parse.failed') {
      status = 400;
      body = { code: 'invalid_json', message: 'The request body is not valid JSON.' };
    } else if (error?.type === 'entity.too.large') {
      status = 413;
      body = { code: 'body_too_large', message: 'The request is too large.' };
    } else if (error?.code === '23514' || error?.code === '22P02' || error?.code === '22007') {
      // Postgres check violation / bad input syntax: the data broke a rule.
      status = 400;
      body = { code: 'invalid_data', message: 'Some of the details sent are not valid.' };
    }

    if (status >= 500) (req.log ?? logger)?.error({ err: error }, 'request failed');
    res.status(status).json({ error: body });
  };
}
