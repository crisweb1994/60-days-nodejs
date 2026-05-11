import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getInfo() {
    return {
      name: 'Blog API (Day 17)',
      pipeline: 'Middleware → Guard → Interceptor → Pipe → Handler → Filter',
      auth: '请求头携带 x-user 和 x-user-roles 即可，示例: x-user: u1, x-user-roles: admin',
    };
  }
}
