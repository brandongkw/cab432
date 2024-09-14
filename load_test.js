const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const videoFile = 'C:/Users/brand/OneDrive/Desktop/My Projects/video-processing-app/videos/test_video.mp4';
const serverUrl = 'http://localhost:3000'; // Replace with your server URL

async function uploadAndProcessVideo() {
    try {
        const formData = new FormData();
        formData.append('videoFile', fs.createReadStream(videoFile));

        // Upload the video
        const uploadResponse = await axios.post(serverUrl+'/upload', formData, {
            headers: formData.getHeaders()
        });

        const video = uploadResponse.data.filename;
        console.log(`Uploaded: ${video}`);

        // Process the video
        const processResponse = await axios.post(serverUrl+ '/process', {
            video: video,
            format: 'mp4',
            resolution: '1080p'
        });

        console.log(`Processing Completed: ${processResponse.data}`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
    }
}

async function loadTest() {
    for (let i = 0; i < 100; i++) {  // Adjust the number of iterations to increase load
        await uploadAndProcessVideo();
    }
}

loadTest();
