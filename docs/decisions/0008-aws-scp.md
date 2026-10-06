# 0008: SCP use in AWS

**Status:** Accepted (Part 4). Part of the "security best practices" need for hosting a publicly accessible system.

## Context

Hosting the demo publicly required the addition of aws guardrails and cost overrun mitigation work.

## Decision

Two SCPs were created.  One to provide guardrails on what the user can access, and limit creation of expensive resources that would not be utilized.  And the second one to freeze the application should a budget be exceeded.  And additional operation to freeze the Lambda service was also created and invoked by the budget. 

## Consequences

- Additional manual deployment steps were created.  
- Additional rollback scripts were created.
- Risks include the possibility that these items could falsely stop the services, or may not limit costs effectively.  These risks are noted in the docs.
