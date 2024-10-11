Assignment 1 - Web Server - Response to Criteria
================================================

Instructions
------------------------------------------------
- Keep this file named A2_response_to_criteria.md, do not change the name
- Upload this file along with your code in the root directory of your project
- Upload this file in the current Markdown format (.md extension)
- Do not delete or rearrange sections.  If you did not attempt a criterion, leave it blank
- Text inside [ ] like [eg. S3 ] are examples and should be removed


Overview
------------------------------------------------

- **Name:** Brandon Gan
- **Student number:** n11381345
- **Partner name (if applicable):** Chew Kai Yuan
- **Partner number (if applicable):** n11529679
- **Application name:** Transvid
- **Two line description:** This video processing web app allows users to upload, preview, and convert video files, with secure cloud storage in AWS S3 and metadata management in DynamoDB. It features real-time progress tracking using WebSockets and ensures seamless handling of persistent connections.
- **EC2 instance name or ID:** i-046ac003ce7ca70d6 (ec2-apsoutheast-2-Brandon)

Core criteria
------------------------------------------------

### Core - First data persistence service

- **AWS service name:** S3
- **What data is being stored?:** Video files
- **Why is this service suited to this data?:** S3 is ideal for storing large files like video due to its scalability and durability. It is also cost-effective for blob storage.
- **Why is are the other services used not suitable for this data?:** DynamoDB and RDS are not optimized for large unstructured data storage like videos.
- **Bucket/instance/table name:** n11381345-assessment-2
- **Video timestamp:**
- **Relevant files:**
    - index.js
    - index.ejs

### Core - Second data persistence service

- **AWS service name:** DynamoDB
- **What data is being stored?:** Video metadata (e.g., filenames, timestamps, videoId, qut-username)
- **Why is this service suited to this data?:** DynamoDB is a NoSQL database optimized for fast reads and writes, making it efficient for storing metadata and handling high concurrency.
- **Why is are the other services used not suitable for this data?:** S3 does not support structured metadata storage and searching as effectively as DynamoDB, and RDS can be overkill for such lightweight data.
- **Bucket/instance/table name:** Group36-A2
- **Video timestamp:**
- **Relevant files:**
    - index.js

### Third data service

- **AWS service name:**  N/A (not applicable for the current scope)
- **What data is being stored?:** N/A
- **Why is this service suited to this data?:** N/A
- **Why is are the other services used not suitable for this data?:** N/A
- **Bucket/instance/table name:** N/A
- **Video timestamp:** N/A
- **Relevant files:**
    - N/A

### S3 Pre-signed URLs

- **S3 Bucket names:** n11381345-assessment-2
- **Video timestamp:**
- **Relevant files:**
    - index.js

### In-memory cache

- **ElastiCache instance name:** N/A (not implemented)
- **What data is being cached?:** N/A
- **Why is this data likely to be accessed frequently?:** N/A
- **Video timestamp:** N/A
- **Relevant files:**
    - N/A

### Core - Statelessness

- **What data is stored within your application that is not stored in cloud data services?:** Transient progress data for video processing is temporarily handled in memory (via WebSocket or SSE), but no persistent state is stored locally.
- **Why is this data not considered persistent state?:** The transient data can be recreated or resumed from the cloud if lost.
- **How does your application ensure data consistency if the app suddenly stops?:** The progress of video processing is reported via WebSockets. In case of disconnection, the client reconnects, and processing information is restored from cloud services.
- **Relevant files:**
    - index.js

### Graceful handling of persistent connections

- **Type of persistent connection and use:** WebSockets for progress reporting during video processing.
- **Method for handling lost connections:** The client detects connection loss and attempts to re-establish the WebSocket connection automatically while notifying the user of the disconnection.
- **Relevant files:**
    - index.js


### Core - Authentication with Cognito

- **User pool name:** ap-southeast-2_esr3bu7ws
- **How are authentication tokens handled by the client?:** Tokens are stored in secure HTTP-only cookies after successful authentication with Cognito.
- **Video timestamp:**
- **Relevant files:**
    - login.ejs
    - register.ejs
    - index.js

### Cognito multi-factor authentication

- **What factors are used for authentication:** N/A
- **Video timestamp:** N/A
- **Relevant files:**
    - N/A

### Cognito federated identities

- **Identity providers used:** N/A
- **Video timestamp:** N/A
- **Relevant files:**
    - N/A

### Cognito groups

- **How are groups used to set permissions?:** Admin users can manage videos (e.g., delete videos); regular users can only upload and view their own videos.
- **Video timestamp:**
- **Relevant files:**
    - index.js

### Core - DNS with Route53

- **Subdomain**:  http://team-36.cab432.com:3000/
- **Video timestamp:**


### Custom security groups

- **Security group names:**
- **Services/instances using security groups:**
- **Video timestamp:**
- **Relevant files:**
    -

### Parameter store

- **Parameter names:** N/A
- **Video timestamp:** N/A
- **Relevant files:**
    - N/A

### Secrets manager

- **Secrets names:** N/A
- **Video timestamp:** N/A
- **Relevant files:**
    - N/A

### Infrastructure as code

- **Technology used:** N/A
- **Services deployed:** N/A
- **Video timestamp:** N/A
- **Relevant files:** 
    - N/A

### Other (with prior approval only)

- **Description:** N/A
- **Video timestamp:** N/A
- **Relevant files:** N/A
    - N/A

### Other (with prior permission only)

- **Description:** N/A
- **Video timestamp:** N/A
- **Relevant files:** N/A
    - N/A
