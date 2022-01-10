-- phpMyAdmin SQL Dump
-- version 4.9.7
-- https://www.phpmyadmin.net/
--
-- Host: localhost:3306
-- Generation Time: Jan 10, 2022 at 11:40 PM
-- Server version: 5.7.32
-- PHP Version: 7.4.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `mghsingles`
--

-- --------------------------------------------------------

--
-- Table structure for table `card`
--

DROP TABLE IF EXISTS `card`;
CREATE TABLE `card` (
  `id` int(11) NOT NULL,
  `scryfallId` varchar(50) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL,
  `conditionId` int(11) NOT NULL,
  `languageId` int(11) NOT NULL,
  `quantity` int(11) NOT NULL,
  `collectionId` int(11) NOT NULL,
  `foil` int(11) DEFAULT NULL,
  `targetPrice` float DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `cardCondition`
--

DROP TABLE IF EXISTS `cardCondition`;
CREATE TABLE `cardCondition` (
  `id` int(11) NOT NULL,
  `name` varchar(20) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `cardGeneral`
--

DROP TABLE IF EXISTS `cardGeneral`;
CREATE TABLE `cardGeneral` (
  `scryfallId` varchar(50) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL,
  `name` varchar(500) NOT NULL,
  `cardSet` varchar(100) NOT NULL,
  `cardSetName` varchar(100) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL,
  `image` varchar(500) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `cardLanguage`
--

DROP TABLE IF EXISTS `cardLanguage`;
CREATE TABLE `cardLanguage` (
  `id` int(11) NOT NULL,
  `name` varchar(20) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `collection`
--

DROP TABLE IF EXISTS `collection`;
CREATE TABLE `collection` (
  `id` int(11) NOT NULL,
  `userId` int(11) NOT NULL,
  `active` int(11) DEFAULT NULL,
  `specialPercent` float DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `generalConfig`
--

DROP TABLE IF EXISTS `generalConfig`;
CREATE TABLE `generalConfig` (
  `percent` float NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `login`
--

DROP TABLE IF EXISTS `login`;
CREATE TABLE `login` (
  `id` int(11) NOT NULL,
  `userId` int(11) NOT NULL,
  `token` varchar(50) NOT NULL,
  `date` int(12) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `sale`
--

DROP TABLE IF EXISTS `sale`;
CREATE TABLE `sale` (
  `id` int(11) NOT NULL,
  `collectionId` int(11) NOT NULL,
  `scryfallId` varchar(100) NOT NULL,
  `price` float NOT NULL,
  `percentage` float NOT NULL,
  `quantity` int(11) NOT NULL,
  `date` int(12) NOT NULL,
  `conditionId` int(11) NOT NULL,
  `languageId` int(11) NOT NULL,
  `foil` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `saleOLD`
--

DROP TABLE IF EXISTS `saleOLD`;
CREATE TABLE `saleOLD` (
  `id` int(11) NOT NULL,
  `collectionId` int(11) NOT NULL,
  `scryfallId` int(11) NOT NULL,
  `price` float NOT NULL,
  `commissionPercent` float NOT NULL,
  `quantity` int(11) NOT NULL,
  `date` int(12) NOT NULL,
  `conditionId` int(11) NOT NULL,
  `languageId` int(11) NOT NULL,
  `foil` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- --------------------------------------------------------

--
-- Table structure for table `user`
--

DROP TABLE IF EXISTS `user`;
CREATE TABLE `user` (
  `id` int(11) NOT NULL,
  `username` varchar(50) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL,
  `name` varchar(50) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL,
  `email` varchar(200) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL,
  `superuser` int(11) DEFAULT NULL,
  `passwordHash` varchar(100) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `card`
--
ALTER TABLE `card`
  ADD PRIMARY KEY (`id`),
  ADD KEY `card_cardGeneral` (`scryfallId`),
  ADD KEY `card_condition` (`conditionId`),
  ADD KEY `card_language` (`languageId`),
  ADD KEY `card_collection` (`collectionId`);

--
-- Indexes for table `cardCondition`
--
ALTER TABLE `cardCondition`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `cardGeneral`
--
ALTER TABLE `cardGeneral`
  ADD PRIMARY KEY (`scryfallId`);

--
-- Indexes for table `cardLanguage`
--
ALTER TABLE `cardLanguage`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `collection`
--
ALTER TABLE `collection`
  ADD PRIMARY KEY (`id`),
  ADD KEY `collection_user` (`userId`);

--
-- Indexes for table `login`
--
ALTER TABLE `login`
  ADD PRIMARY KEY (`id`),
  ADD KEY `login_user` (`userId`);

--
-- Indexes for table `sale`
--
ALTER TABLE `sale`
  ADD PRIMARY KEY (`id`),
  ADD KEY `sale_collection` (`collectionId`),
  ADD KEY `sale_condition` (`conditionId`),
  ADD KEY `sale_language` (`languageId`);

--
-- Indexes for table `saleOLD`
--
ALTER TABLE `saleOLD`
  ADD PRIMARY KEY (`id`),
  ADD KEY `sale_card` (`scryfallId`);

--
-- Indexes for table `user`
--
ALTER TABLE `user`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `card`
--
ALTER TABLE `card`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cardCondition`
--
ALTER TABLE `cardCondition`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cardLanguage`
--
ALTER TABLE `cardLanguage`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `collection`
--
ALTER TABLE `collection`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `login`
--
ALTER TABLE `login`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sale`
--
ALTER TABLE `sale`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `saleOLD`
--
ALTER TABLE `saleOLD`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user`
--
ALTER TABLE `user`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `card`
--
ALTER TABLE `card`
  ADD CONSTRAINT `card_collection` FOREIGN KEY (`collectionId`) REFERENCES `collection` (`id`),
  ADD CONSTRAINT `card_condition` FOREIGN KEY (`conditionId`) REFERENCES `cardCondition` (`id`),
  ADD CONSTRAINT `card_language` FOREIGN KEY (`languageId`) REFERENCES `cardLanguage` (`id`);

--
-- Constraints for table `collection`
--
ALTER TABLE `collection`
  ADD CONSTRAINT `collection_user` FOREIGN KEY (`userId`) REFERENCES `user` (`id`);

--
-- Constraints for table `login`
--
ALTER TABLE `login`
  ADD CONSTRAINT `login_user` FOREIGN KEY (`userId`) REFERENCES `user` (`id`);

--
-- Constraints for table `sale`
--
ALTER TABLE `sale`
  ADD CONSTRAINT `sale_collection` FOREIGN KEY (`collectionId`) REFERENCES `collection` (`id`),
  ADD CONSTRAINT `sale_condition` FOREIGN KEY (`conditionId`) REFERENCES `cardCondition` (`id`),
  ADD CONSTRAINT `sale_language` FOREIGN KEY (`languageId`) REFERENCES `cardLanguage` (`id`);

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
