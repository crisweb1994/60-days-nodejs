import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { UpdatePostDto } from '../src/posts/dto/update-post.dto';
import { PostsService } from '../src/posts/posts.service';

test('partial update keeps omitted post fields', () => {
  const service = new PostsService();
  const post = service.create({
    title: 'Original title',
    content: 'Original content',
    author: 'cris',
    tags: ['nestjs', 'lifecycle'],
    published: true,
  });
  const dto = plainToInstance(UpdatePostDto, { title: 'Updated title' });

  service.update(post.id, dto);

  const updated = service.findOne(post.id);
  assert.equal(updated.title, 'Updated title');
  assert.equal(updated.content, 'Original content');
  assert.equal(updated.author, 'cris');
  assert.deepEqual(updated.tags, ['nestjs', 'lifecycle']);
  assert.equal(updated.published, true);
});
