const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true
    },
    UserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    format: String,
    resolution: String,
}, { timestamps: true });

const Video = mongoose.model('Video', videoSchema);

module.exports = Video;
