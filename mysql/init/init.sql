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
