-- Drop NOT NULL from documentId to allow KB-level global macro nodes (level 2)
ALTER TABLE "RaptorNode" ALTER COLUMN "documentId" DROP NOT NULL;
