import { Module } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { DocumentAclService } from './document-acl.service';

@Module({
  providers: [PermissionService, DocumentAclService],
  exports: [PermissionService, DocumentAclService],
})
export class PermissionModule {}
