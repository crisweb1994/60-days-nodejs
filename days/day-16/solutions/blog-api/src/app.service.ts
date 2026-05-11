import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getInfo() {
    return {
      name: 'Blog API (Day 16)',
      docs: 'GET /posts | POST /posts | GET /posts/:id | PATCH /posts/:id | DELETE /posts/:id',
    };
  }
}
