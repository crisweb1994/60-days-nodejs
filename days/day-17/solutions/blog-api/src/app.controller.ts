import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

// 整个 Controller 都打 @Public()：根路径和健康检查不应该走鉴权
@Public()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return this.appService.getInfo();
  }

  @Get('health')
  getHealth() {
    return { status: 'ok', uptime: process.uptime() };
  }
}
