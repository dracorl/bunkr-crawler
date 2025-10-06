import mongoose from "mongoose";

const albumSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  files: {
    type: String,
    required: true,
  },
  link: {
    type: String,
    required: true,
    unique: true,
  },
  scrapedAt: {
    type: Date,
    default: Date.now,
  },
  state: {
    type: Boolean,
    default: false,
    required: false,
  },
});

export default mongoose.model("Album", albumSchema);
