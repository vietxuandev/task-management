import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { BlueprintService } from "./blueprint.service";

@Module({
  imports: [HttpModule],
  providers: [BlueprintService],
  exports: [BlueprintService],
})
export class BlueprintModule {}
