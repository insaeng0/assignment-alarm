CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  google_sub VARCHAR(255) DEFAULT NULL,
  google_email VARCHAR(255) DEFAULT NULL,
  grade INT NOT NULL,
  class_number INT NOT NULL,
  class_approved TINYINT(1) NOT NULL DEFAULT 0,
  profile_image_url VARCHAR(500) DEFAULT NULL,
  is_alarm_enabled TINYINT(1) DEFAULT 1,
  is_admin TINYINT(1) DEFAULT 0,
  admin_mode_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY users_grade_class_idx (grade, class_number)
);

CREATE TABLE IF NOT EXISTS assignments (
  assignment_id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  due_date DATE NOT NULL,
  target_grade INT NOT NULL,
  target_class INT DEFAULT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE CASCADE,
  KEY assignments_scope_due_created_idx (target_grade, target_class, due_date, created_at),
  KEY assignments_created_at_idx (created_at)
);

-- Private, operator-imported signup suggestions. Names are not identity proof.
CREATE TABLE IF NOT EXISTS student_roster_imports (
  academic_year SMALLINT UNSIGNED NOT NULL,
  grade TINYINT UNSIGNED NOT NULL,
  revision CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entry_count INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (academic_year, grade)
);

CREATE TABLE IF NOT EXISTS student_roster_entries (
  roster_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  academic_year SMALLINT UNSIGNED NOT NULL,
  grade TINYINT UNSIGNED NOT NULL,
  class_number TINYINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  normalized_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  claimed_user_id INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY roster_scope_name_unique (academic_year, grade, class_number, normalized_name),
  UNIQUE KEY roster_year_user_unique (academic_year, claimed_user_id),
  KEY roster_lookup_idx (academic_year, grade, normalized_name, is_active),
  FOREIGN KEY (claimed_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS messages (
  message_id INT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  content TEXT NOT NULL,
  type ENUM('grade', 'class') NOT NULL,
  target_grade INT NOT NULL,
  target_class INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES users(user_id) ON DELETE CASCADE,
  KEY messages_scope_type_created_idx (target_grade, type, target_class, created_at),
  KEY messages_created_at_idx (created_at)
);

CREATE TABLE IF NOT EXISTS user_assignments (
  user_id INT NOT NULL,
  assignment_id INT NOT NULL,
  is_completed TINYINT(1) DEFAULT 0,
  PRIMARY KEY (user_id, assignment_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id) REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  KEY user_assignments_assignment_user_idx (assignment_id, user_id, is_completed)
);

-- Durable login refresh state (hashed credentials only).
CREATE TABLE IF NOT EXISTS auth_refresh_lock (
    lock_id TINYINT NOT NULL PRIMARY KEY
  );
INSERT IGNORE INTO auth_refresh_lock (lock_id) VALUES (1);
CREATE TABLE IF NOT EXISTS auth_refresh_issuance (
    user_id INT NOT NULL PRIMARY KEY, window_ms BIGINT UNSIGNED NOT NULL, issue_count INT UNSIGNED NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
  );
CREATE TABLE IF NOT EXISTS auth_refresh_families (
    family_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    auth_realm_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    current_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    revoked TINYINT(1) NOT NULL DEFAULT 0,
    rate_window_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
    rate_count INT UNSIGNED NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    KEY refresh_realm_active_idx (auth_realm_id, revoked, expires_at_ms),
    KEY refresh_user_created_idx (user_id, created_at_ms)
  );
CREATE TABLE IF NOT EXISTS auth_refresh_history (
    family_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    rotated_at_ms BIGINT UNSIGNED NOT NULL,
    next_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    next_expires_at_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (family_id, token_hash),
    FOREIGN KEY (family_id) REFERENCES auth_refresh_families(family_id) ON DELETE CASCADE
  );
