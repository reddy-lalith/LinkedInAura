// server/index.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Profile = require('./models/Profile');
const Company = require('./models/Company');
const { getOrCreateCompany } = require('./utils/companyUtils');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 4000;

// --- Security Middleware ---
app.use(helmet());

const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? process.env.FRONTEND_URL // Allow only the Vercel frontend domain set in env var
    : '*', // Allow all origins in development
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
};
app.use(cors(corsOptions)); // Apply CORS settings

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);

// --- General Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API Key Authentication Middleware (Define BEFORE routes) ---
const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-admin-api-key'];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    console.warn('Unauthorized API Key attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Connect to MongoDB
console.log('Attempting to connect to MongoDB...');
const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/linkedinAura';
console.log(`Using MongoDB URI: ${mongoURI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);

mongoose.connect(mongoURI)
  .then(() => console.log('📦 Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.error('Please check if:');
    console.error('1. Your connection string is correct');
    console.error('2. Network allows the connection');
    console.error('3. Username and password are correct (if using Atlas)');
  });

// Near the top of the file, after loading env variables
console.log('Logo API Key available:', !!process.env.LOGO_API_KEY);

// --- Routes ---

// Public Routes
app.get('/', (_req, res) => res.send('🚀 LinkedInAura API is live'));
app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await Profile.find().sort({ updatedAt: -1 });
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/profiles/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const profiles = await Profile.find()
      .sort({ elo: -1 })
      .limit(limit);
    
    console.log('Leaderboard profiles:', Array.isArray(profiles) ? 
      `Found ${profiles.length} profiles` : 
      `Not an array: ${typeof profiles}`);
    
    res.json(profiles || []);
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/profiles/:id', async (req, res) => {
  try {
    const profile = await Profile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/companies/search', async (req, res) => {
  try {
    const { name } = req.query;
    const company = await Company.findOne({
      $or: [
        { name: new RegExp(name, 'i') },
        { aliases: new RegExp(name, 'i') }
      ]
    });
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/profiles', async (req, res) => {
  try {
    const profileData = req.body;

    // Process each experience to ensure companies exist
    if (profileData.experiences) {
      for (const exp of profileData.experiences) {
        const company = await getOrCreateCompany(exp.company);
        if (company) {
          exp.companyLogo = company.logoUrl;
        }
      }
    }

    const profile = new Profile(profileData);
    await profile.save();
    res.status(201).json(profile);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.put('/api/profiles/:id', async (req, res) => {
  try {
    const profileData = req.body;

    // Process each experience to ensure companies exist
    if (profileData.experiences) {
      for (const exp of profileData.experiences) {
        const company = await getOrCreateCompany(exp.company);
        if (company) {
          exp.companyLogo = company.logoUrl;
        }
      }
    }

    const profile = await Profile.findByIdAndUpdate(
      req.params.id,
      profileData,
      { new: true }
    );
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Protected Routes (Apply requireApiKey middleware)
app.post('/api/companies', requireApiKey, async (req, res) => {
  try {
    const { name, logoUrl, aliases = [] } = req.body;
    const company = new Company({ name, logoUrl, aliases });
    await company.save();
    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/company-domains', requireApiKey, async (req, res) => {
  try {
    const { companyName, domain } = req.body;
    
    // Update existing company if it exists
    const company = await Company.findOne({ name: companyName });
    if (company) {
      company.logoUrl = `https://img.logo.dev/${domain}?token=${process.env.LOGO_API_KEY}&format=png`;
      company.domain = domain;
      await company.save();
    }

    res.json({ message: 'Domain mapping updated', company });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.delete('/api/profiles/:id', requireApiKey, async (req, res) => {
  try {
    const profile = await Profile.findByIdAndDelete(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json({ message: 'Profile deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.delete('/api/profiles', requireApiKey, async (req, res) => {
  try {
    await Profile.deleteMany({});
    res.json({ message: 'All profiles deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/profiles/:id/refresh-logos', requireApiKey, async (req, res) => {
  try {
    const profile = await Profile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Refresh company logos
    if (profile.experiences) {
      for (const exp of profile.experiences) {
        const company = await getOrCreateCompany(exp.company);
        if (company) {
          exp.companyLogo = company.logoUrl;
        }
      }
    }

    await profile.save();
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/profiles/refresh-all-logos', requireApiKey, async (req, res) => {
  try {
    const profiles = await Profile.find();
    let updatedCount = 0;

    for (const profile of profiles) {
      let updated = false;

      if (profile.experiences && Array.isArray(profile.experiences)) {
        for (const exp of profile.experiences) {
          const company = await getOrCreateCompany(exp.company, true);
          if (company) {
            exp.companyLogo = company.logoUrl;
            updated = true;
          }
        }
      }

      if (updated) {
        await profile.save();
        updatedCount++;
      }
    }

    res.json({ success: true, message: `Updated logos for ${updatedCount} profiles` });
  } catch (error) {
    console.error('Error refreshing logos:', error);
    res.status(500).json({ success: false, error: 'Failed to refresh logos' });
  }
});
app.delete('/api/companies', requireApiKey, async (req, res) => {
  try {
    await Company.deleteMany({});
    res.json({ message: 'All companies deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Basic Error Handling Improvement (Add just before app.listen)
// Catch-all for other errors - improve this with a proper error handling middleware later
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err.stack);

  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Internal Server Error' });
  } else {
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message,
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));