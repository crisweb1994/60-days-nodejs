import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpStatus } from '@nestjs/common';
import { createAppValidationPipe } from '../src/main';
import { CreatePostDto } from '../src/posts/dto/create-post.dto';

test('global validation pipe reports validation failures as 422', async () => {
  const pipe = createAppValidationPipe();

  await assert.rejects(
    () => pipe.transform(
      { title: 'Missing required fields' },
      { type: 'body', metatype: CreatePostDto },
    ),
    (err: unknown) => {
      return typeof err === 'object'
        && err !== null
        && 'getStatus' in err
        && typeof err.getStatus === 'function'
        && err.getStatus() === HttpStatus.UNPROCESSABLE_ENTITY;
    },
  );
});
