import mongoose from "mongoose";

const fileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    required: true,
  },
  size: {
    type: String,
    required: true,
  },
  link: {
    type: String,
    required: true,
  },
  albumLink: {
    type: String,
    required: true,
  },
  scrapedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model("File", fileSchema);
