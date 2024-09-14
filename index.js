require('dotenv').config();
const express = require('express');
const http = require('http');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const session = require('express-session');
const bcrypt = require('bcryptjs');
const flash = require('connect-flash');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const User = require('./models/user');
const Video = require('./models/video');
const app = express();
const port = process.env.PORT || 3000;
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegPath);

// Create an HTTP server using the express app
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket connection
wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    ws.on('message', (message) => {
        console.log('received:', message);
    });

    // Send progress updates to the client
    ws.send(JSON.stringify({ progress: 0 }));
    let progress = 0;
    const interval = setInterval(() => {
        progress += 10;
        ws.send(JSON.stringify({ progress }));
        if (progress >= 100) {
            clearInterval(interval);
            ws.send(JSON.stringify({ progress: 'Complete' }));
        }
    }, 1000);
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// Send progress updates
function sendProgressUpdate(ws, progress) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ progress }));
    }
}

function isAuthenticated(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) {
        return next();
    } else {
        res.redirect('/login');
    }
}

// Connect to MongoDB
mongoose.connect(process.env.DATABASE_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch((err) => console.error('MongoDB connection error:', err));

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use('/videos', express.static(path.join(__dirname, 'videos')));
app.use(session({
    secret: process.env.SECRET_KEY,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// View engine setup
app.set('view engine', 'ejs');

// Passport authentication strategy
passport.use(new LocalStrategy(async (username, password, done) => {
    try {
        const user = await User.findOne({ username });
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return done(null, false, { message: 'Incorrect username or password.' });
        }
        return done(null, user);
    } catch (error) {
        return done(error);
    }
}));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// Routes for user authentication
app.get('/', isAuthenticated, (req, res) => {
    res.render('index', { 
        video: null, 
        preview: null, 
        msg: '', 
        user: req.user || null
    });
});

app.get('/login', (req, res) => {
    res.render('login', { message: req.flash('error') });
});

app.post('/login', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash: true
}));

app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    try {
        const user = await User.create({ username, password: hashedPassword });
        res.redirect('/login');
    } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).send('Error registering user');
    }
});

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/login');
    });
});

// Set storage engine for Multer
const storage = multer.diskStorage({
    destination: './videos/',
    filename: (req, file, cb) => {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Init upload
const upload = multer({
    storage: storage,
    limits: { fileSize: 1000000000 }, // 1GB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /mp4|avi|mov|mkv/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb('Error: Videos Only!');
        }
    }
}).single('videoFile');

// Route for uploading videos
app.post('/upload', isAuthenticated, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.render('index', { msg: err, user: req.user });
        }
        if (!req.file) {
            return res.render('index', { msg: 'No file selected!', user: req.user });
        }
        try {
            const video = await Video.create({
                filename: req.file.filename,
                UserId: req.user.id,
            });
            res.render('index', { 
                video: req.file.filename, 
                preview: null, 
                msg: 'Video uploaded successfully', 
                user: req.user  // Pass the user object
            });
        } catch (error) {
            console.error('Error uploading video:', error);
            res.status(500).send('Error uploading video');
        }
    });
});

// Route for processing videos
app.post('/process', isAuthenticated, (req, res) => {
    const { format, resolution, video } = req.body;

    if (!format || !resolution || !video) {
        return res.status(400).send('Format, resolution, or video file not specified.');
    }

    const output = `./videos/processed-${Date.now()}.${format}`;
    
    let scaleOption;
    switch (resolution) {
        case '1080p':
            scaleOption = '1920:1080';
            break;
        case '720p':
            scaleOption = '1280:720';
            break;
        case '480p':
            scaleOption = '640:480';
            break;
        default:
            scaleOption = '1920:1080'; // Default to 1080p
            break;
    }

    ffmpeg(`./videos/${video}`)
        .outputOptions(['-vf', `scale=${scaleOption}`])
        .toFormat(format)
        .output(output)
        .on('end', () => {
            res.download(output);
        })
        .on('error', (err) => {
            console.error('Error during processing:', err);
            res.status(500).send('Error processing video');
        })
        .run();
});

// Route to get uploaded videos for the user
app.get('/api/videos', isAuthenticated, async (req, res) => {
    try {
        const videos = await Video.find({ UserId: req.user._id });
        res.json(videos);
    } catch (err) {
        res.status(500).send('Error fetching videos');
    }
});

// Route to delete a video
app.delete('/api/videos/:id', isAuthenticated, async (req, res) => {
    try {
        // Find and delete the video from the database
        const video = await Video.findByIdAndDelete(req.params.id);
        if (!video) {
            return res.status(404).send('Video not found');
        }

        // Construct the file path based on the video filename
        const filePath = path.join(__dirname, 'videos', video.filename);

        // Check if the file exists before trying to delete it
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log('File deleted:', filePath);
        } else {
            console.log('File not found:', filePath);
        }

        // Respond with success
        res.status(200).send('Video deleted successfully');
    } catch (err) {
        console.error('Error deleting video:', err);
        res.status(500).send('Error deleting video');
    }
});

app.get('/search', isAuthenticated, async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).send('Query is required');
    }

    try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                q: query,
                key: process.env.YOUTUBE_API_KEY,
                maxResults: 5,
            }
        });

        const videos = response.data.items.map(item => ({
            title: item.snippet.title,
            description: item.snippet.description,
            thumbnail: item.snippet.thumbnails.default.url,
            videoId: item.id.videoId,
        }));

        res.render('searchResults', { videos, query, user: req.user || null });

    } catch (error) {
        console.error('Error fetching data from YouTube:', error);
        res.status(500).send('Error fetching data from YouTube');
    }
});

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
