<?php
// PHP carries the delimiters inside the string
preg_match('/(a+)+/', $subject, $matches);
// A different delimiter, with a modifier
preg_replace('#([a-z]+)*#i', '', $subject);
// Tilde, and a bracket pair
preg_split('~\d{2,}~', $subject);
preg_match_all('{^[A-Z]+$}', $subject, $all);
