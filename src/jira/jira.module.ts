import { Global, Module } from '@nestjs/common';
import { JiraService } from './jira.service';

@Global()
@Module({
  providers: [JiraService],
  exports: [JiraService],
})
export class JiraModule {}
