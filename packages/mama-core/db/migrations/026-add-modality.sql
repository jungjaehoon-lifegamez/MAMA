-- Add modality column to decisions table
-- Values: completed, plan, past_habit, state, preference (nullable for legacy records)
ALTER TABLE decisions ADD COLUMN modality TEXT;

-- Add entities column (JSON array of key entities)
ALTER TABLE decisions ADD COLUMN entities TEXT;
