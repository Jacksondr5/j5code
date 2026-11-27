INSERT INTO password (email, username, user_id, hash, email_verified)
VALUES ('ada@example.test', 'Ada Test', 'ada-fixture',
        convert_to('$2b$12$oLzqrU41ts5iEqouyYhgCuUyB4Ex0yAzCL62BH0nzF6AmknH87LPO', 'UTF8'), true)
ON CONFLICT (email) DO NOTHING;
